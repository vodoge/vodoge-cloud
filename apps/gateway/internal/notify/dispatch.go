package notify

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// SettingsReader hands the dispatcher a tenant's notification configuration.
type SettingsReader interface {
	Get(ctx context.Context, tenantID, section string) (map[string]any, error)
}

// Recorder is the slice of the metrics registry this package needs.
//
// An interface rather than *observe.Registry so a test can watch what was
// counted, and so a dispatcher built without metrics is a nil field rather
// than a special case.
type Recorder interface {
	Add(name string, delta int64, labels ...string)
}

// Metric names for delivery outcomes. Declared in observe alongside every
// other series this process reports; see observe.DeclareNotifications.
const (
	metricDelivered = "vodoge_notifications_total"
	metricRetries   = "vodoge_notification_retries_total"
	metricDropped   = "vodoge_notifications_dropped_total"
)

// Defaults for the retry policy.
//
// The first delay is short because most failures are a receiver restarting,
// and doubling to a 45 second ceiling keeps a long outage from turning into a
// tight loop against something that is plainly down. The window is what
// matters: with these numbers a channel is retried at roughly
// 0s 1s 3s 7s 15s 31s 63s 108s 153s ... until six minutes have passed, so a
// receiver that is down for a minute still gets the notification.
//
// The previous policy was three attempts two seconds apart — about four
// seconds of tolerance, which covers a dropped packet and nothing else.
const (
	defaultAttempts       = 64
	defaultBackoff        = time.Second
	defaultMaxBackoff     = 45 * time.Second
	defaultRetryWindow    = 6 * time.Minute
	defaultAttemptTimeout = 45 * time.Second
	defaultSettingsWait   = 10 * time.Second
	defaultDepth          = 256
	defaultLaneDepth      = 64
	defaultMaxLanes       = 64
	// closeGrace bounds how long Close waits for in-flight sends before it
	// cancels them. Shutdown must not inherit the retry window.
	closeGrace = 5 * time.Second
)

// Drop reasons, as the label on the dropped counter.
const (
	dropQueueFull  = "queue_full"
	dropLaneFull   = "lane_full"
	dropLaneLimit  = "lane_limit"
	dropNoSettings = "settings_unavailable"
)

// Dispatcher delivers events to every channel a tenant has configured.
//
// Delivery is off the caller's path. Whatever produced the event — an inbound
// message, a failed command — has already done its real work, and must not
// fail or wait because someone's SMTP server is slow.
//
// One goroutine reads the intake queue and does nothing slow: it looks up the
// tenant's settings and hands the event to a lane. A lane is one
// (tenant, channel) pair with its own goroutine and its own small queue, and
// it is where the waiting happens. That split is the whole point. Delivery
// used to run on the single intake goroutine, so one webhook with three dead
// URLs held it for the better part of a minute while every other tenant's
// events piled up in a 256-deep queue and were then dropped. A tenant could
// lose notifications because a different tenant misconfigured a URL.
type Dispatcher struct {
	settings SettingsReader
	channels []Channel
	queue    chan Event
	wg       sync.WaitGroup

	policy    retryPolicy
	laneDepth int
	maxLanes  int

	// ctx is cancelled by Close, after a grace period, to abandon sends that
	// are still in flight.
	ctx      context.Context
	cancel   context.CancelFunc
	stopping chan struct{}
	once     sync.Once

	now      func() time.Time
	metrics  Recorder
	onResult func(channel string, event Event, err error)
}

// retryPolicy is the schedule one event follows against one channel.
type retryPolicy struct {
	attempts       int
	backoff        time.Duration
	maxBackoff     time.Duration
	window         time.Duration
	attemptTimeout time.Duration
	settingsWait   time.Duration
}

// Options configures a dispatcher. Zero values give sensible defaults.
type Options struct {
	// Depth is how many events may be waiting for fan-out. Beyond it, events
	// are dropped rather than blocking whatever produced them — a
	// notification backlog must never become back-pressure on the uplink.
	Depth int
	// Attempts caps how many times one event is offered to one channel. It is
	// a safety rail; RetryWindow is normally what stops the loop.
	Attempts int
	// Backoff is the first wait between attempts. Each subsequent wait
	// doubles, up to MaxBackoff.
	Backoff    time.Duration
	MaxBackoff time.Duration
	// RetryWindow is how long one event may keep being retried.
	RetryWindow time.Duration
	// AttemptTimeout bounds a single Send.
	AttemptTimeout time.Duration
	// SettingsTimeout bounds the settings lookup on the intake goroutine,
	// which is shared by every tenant.
	SettingsTimeout time.Duration
	// LaneDepth is how many events may wait per (tenant, channel). MaxLanes
	// caps how many such pairs get a goroutine.
	LaneDepth int
	MaxLanes  int
	// Metrics counts deliveries, retries and drops. Optional.
	Metrics  Recorder
	OnResult func(channel string, event Event, err error)
}

// New starts a dispatcher. Stop it with Close.
func New(settings SettingsReader, channels []Channel, options Options) *Dispatcher {
	if options.Depth <= 0 {
		options.Depth = defaultDepth
	}
	if options.Attempts <= 0 {
		options.Attempts = defaultAttempts
	}
	if options.Backoff <= 0 {
		options.Backoff = defaultBackoff
	}
	if options.MaxBackoff <= 0 {
		options.MaxBackoff = defaultMaxBackoff
	}
	if options.MaxBackoff < options.Backoff {
		options.MaxBackoff = options.Backoff
	}
	if options.RetryWindow <= 0 {
		options.RetryWindow = defaultRetryWindow
	}
	if options.AttemptTimeout <= 0 {
		options.AttemptTimeout = defaultAttemptTimeout
	}
	if options.SettingsTimeout <= 0 {
		options.SettingsTimeout = defaultSettingsWait
	}
	if options.LaneDepth <= 0 {
		options.LaneDepth = defaultLaneDepth
	}
	if options.MaxLanes <= 0 {
		options.MaxLanes = defaultMaxLanes
	}
	ctx, cancel := context.WithCancel(context.Background())
	dispatcher := &Dispatcher{
		settings: settings,
		channels: channels,
		queue:    make(chan Event, options.Depth),
		policy: retryPolicy{
			attempts:       options.Attempts,
			backoff:        options.Backoff,
			maxBackoff:     options.MaxBackoff,
			window:         options.RetryWindow,
			attemptTimeout: options.AttemptTimeout,
			settingsWait:   options.SettingsTimeout,
		},
		laneDepth: options.LaneDepth,
		maxLanes:  options.MaxLanes,
		ctx:       ctx,
		cancel:    cancel,
		stopping:  make(chan struct{}),
		now:       time.Now,
		metrics:   options.Metrics,
		onResult:  options.OnResult,
	}
	dispatcher.wg.Add(1)
	go dispatcher.run()
	return dispatcher
}

// Notify queues an event. It never blocks and never fails.
//
// A dropped notification is logged, counted and forgotten. The alternative —
// blocking the caller until a queue drains — would let a misconfigured webhook
// stall the device uplink, which is a far worse outcome than a missed nudge.
func (dispatcher *Dispatcher) Notify(event Event) {
	if dispatcher == nil {
		return
	}
	if event.At.IsZero() {
		event.At = dispatcher.now()
	}
	select {
	case <-dispatcher.stopping:
		return
	default:
	}
	select {
	case dispatcher.queue <- event:
	default:
		dispatcher.dropped(dropQueueFull, "", event)
	}
}

// Close drains what is already queued and stops the workers.
//
// Bounded: retries are abandoned immediately and anything still inside a Send
// gets closeGrace before its context is cancelled. A shutdown that inherited
// the six minute retry window would be a hung deploy.
func (dispatcher *Dispatcher) Close() {
	if dispatcher == nil {
		return
	}
	dispatcher.once.Do(func() {
		// The intake queue is signalled rather than closed: Notify runs on
		// request paths that have no idea a shutdown started, and a send on a
		// closed channel panics.
		close(dispatcher.stopping)
		done := make(chan struct{})
		go func() {
			dispatcher.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(closeGrace):
			dispatcher.cancel()
			<-done
		}
		dispatcher.cancel()
	})
}

// lane is one (tenant, channel) pair: its own queue, its own goroutine.
type lane struct {
	channel Channel
	queue   chan laneJob
}

type laneJob struct {
	event  Event
	config map[string]any
}

func (dispatcher *Dispatcher) run() {
	defer dispatcher.wg.Done()
	// Owned by this goroutine alone, so no lock. Nothing else creates lanes,
	// and this is the only place their queues are closed.
	lanes := map[string]*lane{}
	defer func() {
		for _, open := range lanes {
			close(open.queue)
		}
	}()
	for {
		select {
		case event := <-dispatcher.queue:
			dispatcher.fanOut(lanes, event)
		case <-dispatcher.stopping:
			for {
				select {
				case event := <-dispatcher.queue:
					dispatcher.fanOut(lanes, event)
				default:
					return
				}
			}
		}
	}
}

// fanOut resolves a tenant's channels and hands the event to each lane.
//
// Everything here must be quick. This goroutine is shared by every tenant, so
// a slow step is head-of-line blocking for all of them — which is exactly the
// failure this design exists to remove.
func (dispatcher *Dispatcher) fanOut(lanes map[string]*lane, event Event) {
	ctx, cancel := context.WithTimeout(dispatcher.ctx, dispatcher.policy.settingsWait)
	settings, err := dispatcher.settings.Get(ctx, event.TenantID, "notifications")
	cancel()
	if err != nil {
		slog.Warn("notification settings unavailable",
			"tenant_id", event.TenantID, "error", err)
		dispatcher.dropped(dropNoSettings, "", event)
		return
	}

	for _, channel := range dispatcher.channels {
		config := section(settings, channel.Name())
		if !channel.Configured(config) {
			continue
		}
		key := event.TenantID + "\x00" + channel.Name()
		open, exists := lanes[key]
		if !exists {
			if len(lanes) >= dispatcher.maxLanes {
				// Lanes are never retired, so this is the ceiling on how many
				// goroutines a long tenant list can create.
				slog.Warn("notification lane limit reached",
					"tenant_id", event.TenantID, "channel", channel.Name())
				dispatcher.dropped(dropLaneLimit, channel.Name(), event)
				continue
			}
			open = &lane{
				channel: channel,
				queue:   make(chan laneJob, dispatcher.laneDepth),
			}
			lanes[key] = open
			dispatcher.wg.Add(1)
			go dispatcher.runLane(open)
		}
		select {
		case open.queue <- laneJob{event: event, config: config}:
		default:
			// This lane is behind. Only this tenant's events on this channel
			// are lost, which is the difference from the old design.
			slog.Warn("notification dropped, channel backlog full",
				"tenant_id", event.TenantID, "channel", channel.Name(),
				"kind", string(event.Kind))
			dispatcher.dropped(dropLaneFull, channel.Name(), event)
		}
	}
}

func (dispatcher *Dispatcher) runLane(open *lane) {
	defer dispatcher.wg.Done()
	for job := range open.queue {
		err := dispatcher.attempt(open.channel, job.config, job.event)
		if dispatcher.onResult != nil {
			dispatcher.onResult(open.channel.Name(), job.event, err)
		}
		switch {
		case err == nil:
			dispatcher.count(metricDelivered,
				"channel", open.channel.Name(), "result", "delivered")
		case errors.Is(err, ErrNotConfigured):
			dispatcher.count(metricDelivered,
				"channel", open.channel.Name(), "result", "not_configured")
		default:
			dispatcher.count(metricDelivered,
				"channel", open.channel.Name(), "result", "failed")
			slog.Warn("notification failed",
				"tenant_id", job.event.TenantID, "channel", open.channel.Name(),
				"kind", string(job.event.Kind), "error", err)
		}
	}
}

// attempt offers one event to one channel until it lands, the window closes,
// or the attempt cap is reached.
func (dispatcher *Dispatcher) attempt(
	channel Channel,
	config map[string]any,
	event Event,
) error {
	deadline := dispatcher.now().Add(dispatcher.policy.window)
	delay := dispatcher.policy.backoff
	var last error
	for tries := 1; ; tries++ {
		ctx, cancel := context.WithTimeout(
			dispatcher.ctx, dispatcher.policy.attemptTimeout)
		last = channel.Send(ctx, config, event)
		cancel()
		if last == nil {
			return nil
		}
		// A channel that says it is not configured will say so again. Retrying
		// is pure delay.
		if errors.Is(last, ErrNotConfigured) {
			return last
		}
		if tries >= dispatcher.policy.attempts {
			return last
		}
		if !dispatcher.now().Before(deadline) {
			return last
		}
		if !dispatcher.wait(delay) {
			return last
		}
		dispatcher.count(metricRetries, "channel", channel.Name())
		delay = min(delay*2, dispatcher.policy.maxBackoff)
	}
}

// wait sleeps for the backoff, reporting false if the dispatcher is shutting
// down. Retries are the first thing abandoned on shutdown.
func (dispatcher *Dispatcher) wait(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-dispatcher.stopping:
		return false
	case <-dispatcher.ctx.Done():
		return false
	}
}

// dropped records a notification nobody will ever receive, so that "how many
// did we lose" has an answer that is not grepping a log.
func (dispatcher *Dispatcher) dropped(reason, channel string, event Event) {
	if reason == dropQueueFull {
		slog.Warn("notification dropped, queue full",
			"tenant_id", event.TenantID, "kind", string(event.Kind))
	}
	dispatcher.count(metricDropped, "reason", reason, "channel", channel)
}

func (dispatcher *Dispatcher) count(name string, labels ...string) {
	if dispatcher.metrics == nil {
		return
	}
	dispatcher.metrics.Add(name, 1, labels...)
}

// SendTest delivers one event to a single named channel, synchronously, and
// returns what happened.
//
// Synchronous and unqueued because this is the "send a test" button: the whole
// point is that the person pressing it sees the result, including the failure.
// It does not retry either — a person waiting on a button wants the answer,
// not six minutes of patience exercised on their behalf.
func (dispatcher *Dispatcher) SendTest(
	ctx context.Context,
	tenantID, channelName string,
) error {
	settings, err := dispatcher.settings.Get(ctx, tenantID, "notifications")
	if err != nil {
		return err
	}
	for _, channel := range dispatcher.channels {
		if channel.Name() != channelName {
			continue
		}
		config := section(settings, channelName)
		if !channel.Configured(config) {
			return ErrNotConfigured
		}
		return channel.Send(ctx, config, Event{
			Kind:     KindTest,
			TenantID: tenantID,
			Title:    "VoDoge 测试通知",
			Body:     "如果你看到这条，说明这个渠道配置正确。",
			At:       dispatcher.now(),
		})
	}
	return ErrNotConfigured
}

// ChannelNames lists the channels this build can deliver through.
func (dispatcher *Dispatcher) ChannelNames() []string {
	names := make([]string, 0, len(dispatcher.channels))
	for _, channel := range dispatcher.channels {
		names = append(names, channel.Name())
	}
	return names
}
