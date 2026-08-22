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

// Dispatcher delivers events to every channel a tenant has configured.
//
// Delivery is off the caller's path. Whatever produced the event — an inbound
// message, a failed command — has already done its real work, and must not
// fail or wait because someone's SMTP server is slow.
type Dispatcher struct {
	settings SettingsReader
	channels []Channel
	queue    chan Event
	wg       sync.WaitGroup
	// attempts is how many times one event is offered to a failing channel.
	attempts int
	// backoff is the wait between attempts.
	backoff time.Duration
	now     func() time.Time
	// sent records deliveries for tests.
	onResult func(channel string, event Event, err error)
}

// Options configures a dispatcher. Zero values give sensible defaults.
type Options struct {
	// Depth is how many events may be waiting. Beyond it, events are dropped
	// rather than blocking whatever produced them — a notification backlog
	// must never become back-pressure on the uplink.
	Depth    int
	Attempts int
	Backoff  time.Duration
	OnResult func(channel string, event Event, err error)
}

// New starts a dispatcher. Stop it with Close.
func New(settings SettingsReader, channels []Channel, options Options) *Dispatcher {
	if options.Depth <= 0 {
		options.Depth = 256
	}
	if options.Attempts <= 0 {
		options.Attempts = 3
	}
	if options.Backoff <= 0 {
		options.Backoff = 2 * time.Second
	}
	dispatcher := &Dispatcher{
		settings: settings,
		channels: channels,
		queue:    make(chan Event, options.Depth),
		attempts: options.Attempts,
		backoff:  options.Backoff,
		now:      time.Now,
		onResult: options.OnResult,
	}
	dispatcher.wg.Add(1)
	go dispatcher.run()
	return dispatcher
}

// Notify queues an event. It never blocks and never fails.
//
// A dropped notification is logged and forgotten. The alternative — blocking
// the caller until a queue drains — would let a misconfigured webhook stall
// the device uplink, which is a far worse outcome than a missed nudge.
func (dispatcher *Dispatcher) Notify(event Event) {
	if dispatcher == nil {
		return
	}
	if event.At.IsZero() {
		event.At = dispatcher.now()
	}
	select {
	case dispatcher.queue <- event:
	default:
		slog.Warn("notification dropped, queue full",
			"tenant_id", event.TenantID, "kind", string(event.Kind))
	}
}

// Close drains the queue and stops the worker.
func (dispatcher *Dispatcher) Close() {
	if dispatcher == nil {
		return
	}
	close(dispatcher.queue)
	dispatcher.wg.Wait()
}

func (dispatcher *Dispatcher) run() {
	defer dispatcher.wg.Done()
	for event := range dispatcher.queue {
		dispatcher.deliver(event)
	}
}

func (dispatcher *Dispatcher) deliver(event Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	settings, err := dispatcher.settings.Get(ctx, event.TenantID, "notifications")
	if err != nil {
		slog.Warn("notification settings unavailable",
			"tenant_id", event.TenantID, "error", err)
		return
	}

	for _, channel := range dispatcher.channels {
		config := section(settings, channel.Name())
		if !channel.Configured(config) {
			continue
		}
		// Each channel gets its own attempts. One failing does not deprive
		// the others — a broken SMTP server should not cost the webhook.
		err := dispatcher.attempt(ctx, channel, config, event)
		if dispatcher.onResult != nil {
			dispatcher.onResult(channel.Name(), event, err)
		}
		if err != nil {
			slog.Warn("notification failed",
				"tenant_id", event.TenantID, "channel", channel.Name(),
				"kind", string(event.Kind), "error", err)
		}
	}
}

func (dispatcher *Dispatcher) attempt(
	ctx context.Context,
	channel Channel,
	config map[string]any,
	event Event,
) error {
	var last error
	for i := 0; i < dispatcher.attempts; i++ {
		if i > 0 {
			select {
			case <-time.After(dispatcher.backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		last = channel.Send(ctx, config, event)
		if last == nil {
			return nil
		}
		// A channel that says it is not configured will say so again. Retrying
		// is pure delay.
		if errors.Is(last, ErrNotConfigured) {
			return last
		}
	}
	return last
}

// SendTest delivers one event to a single named channel, synchronously, and
// returns what happened.
//
// Synchronous and unqueued because this is the "send a test" button: the whole
// point is that the person pressing it sees the result, including the failure.
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
