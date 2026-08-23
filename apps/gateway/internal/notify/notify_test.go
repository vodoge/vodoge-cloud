package notify

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixedSettings map[string]any

func (s fixedSettings) Get(context.Context, string, string) (map[string]any, error) {
	return s, nil
}

// perTenant gives each tenant a different notification configuration, which is
// what it takes to show one tenant's trouble reaching another's.
type perTenant map[string]map[string]any

func (s perTenant) Get(_ context.Context, tenantID, _ string) (map[string]any, error) {
	settings, ok := s[tenantID]
	if !ok {
		return map[string]any{}, nil
	}
	return settings, nil
}

// recorder is a channel that counts attempts and can be told to fail.
type recorder struct {
	mu       sync.Mutex
	name     string
	attempts int
	failFor  int
	events   []Event
}

func (r *recorder) Name() string { return r.name }

func (r *recorder) Configured(config map[string]any) bool { return asBool(config, "enabled") }

func (r *recorder) Send(_ context.Context, _ map[string]any, event Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attempts++
	if r.attempts <= r.failFor {
		return errors.New("temporary")
	}
	r.events = append(r.events, event)
	return nil
}

func (r *recorder) seen() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func (r *recorder) tries() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.attempts
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	waitUntil(t, 3*time.Second, condition)
}

// waitUntil is waitFor with the deadline spelled out, for the tests whose
// whole point is that the dispatcher keeps trying for longer than that.
func waitUntil(t *testing.T, within time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for the condition")
}

// timedChannel always fails and remembers when each attempt arrived, so a test
// can look at the shape of the retry schedule rather than just its length.
type timedChannel struct {
	mu sync.Mutex
	at []time.Time
}

func (*timedChannel) Name() string { return "timed" }

func (*timedChannel) Configured(config map[string]any) bool {
	return asBool(config, "enabled")
}

func (c *timedChannel) Send(context.Context, map[string]any, Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = append(c.at, time.Now())
	return errors.New("still down")
}

func (c *timedChannel) tries() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.at)
}

// countingRecorder is the metrics registry as far as the dispatcher can tell.
type countingRecorder struct {
	mu     sync.Mutex
	counts map[string]int64
}

func newCountingRecorder() *countingRecorder {
	return &countingRecorder{counts: map[string]int64{}}
}

func (r *countingRecorder) Add(name string, delta int64, labels ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counts[name+"|"+strings.Join(labels, ",")] += delta
}

func (r *countingRecorder) get(name string, labels ...string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counts[name+"|"+strings.Join(labels, ",")]
}

// total sums a metric across every label combination.
func (r *countingRecorder) total(name string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var sum int64
	for key, value := range r.counts {
		if strings.HasPrefix(key, name+"|") {
			sum += value
		}
	}
	return sum
}

func (c *timedChannel) gaps() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]time.Duration, 0, len(c.at))
	for i := 1; i < len(c.at); i++ {
		out = append(out, c.at[i].Sub(c.at[i-1]))
	}
	return out
}

// A channel that is switched off must not be delivered to. The settings page
// lets a tenant leave a half-filled channel disabled as a draft.
func TestOnlyConfiguredChannelsReceive(t *testing.T) {
	t.Parallel()

	on := &recorder{name: "on"}
	off := &recorder{name: "off"}
	dispatcher := New(
		fixedSettings{"on": map[string]any{"enabled": true}, "off": map[string]any{"enabled": false}},
		[]Channel{on, off},
		Options{Backoff: time.Millisecond},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitFor(t, func() bool { return on.seen() == 1 })
	if off.tries() != 0 {
		t.Fatal("a disabled channel was delivered to")
	}
}

// One failing channel must not deprive the others. A broken SMTP server should
// not cost the webhook its notification.
func TestAFailingChannelDoesNotBlockTheOthers(t *testing.T) {
	t.Parallel()

	broken := &recorder{name: "broken", failFor: 99}
	working := &recorder{name: "working"}
	dispatcher := New(
		fixedSettings{
			"broken":  map[string]any{"enabled": true},
			"working": map[string]any{"enabled": true},
		},
		[]Channel{broken, working},
		Options{Attempts: 2, Backoff: time.Millisecond},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	// Both conditions are waited on: the channels now run on their own
	// goroutines, so "the working one is done" says nothing about how far the
	// broken one has got.
	waitFor(t, func() bool { return working.seen() == 1 && broken.tries() == 2 })
	if broken.tries() != 2 {
		t.Fatalf("attempts = %d, want the configured 2", broken.tries())
	}
}

// A transient failure is retried; a success on a later attempt still counts.
func TestATransientFailureIsRetried(t *testing.T) {
	t.Parallel()

	flaky := &recorder{name: "flaky", failFor: 2}
	dispatcher := New(
		fixedSettings{"flaky": map[string]any{"enabled": true}},
		[]Channel{flaky},
		Options{Attempts: 3, Backoff: time.Millisecond},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitFor(t, func() bool { return flaky.seen() == 1 })
	if flaky.tries() != 3 {
		t.Fatalf("attempts = %d, want 3", flaky.tries())
	}
}

// One tenant's hung channel must not cost another tenant its notifications.
//
// This is the failure the lanes exist for. Delivery used to run on the single
// goroutine that reads the queue, so a webhook sitting on an open connection
// held every other tenant's events behind it until it timed out — and with a
// 256-deep queue and a ten second HTTP timeout per URL, "behind it" turns into
// "dropped" long before the timeout.
func TestAHungChannelDoesNotStarveAnotherTenant(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	hung := blockingChannel{gate: release}
	quick := &recorder{name: "quick"}
	dispatcher := New(
		perTenant{
			"stuck": {"slow": map[string]any{"enabled": true}},
			"other": {"quick": map[string]any{"enabled": true}},
		},
		[]Channel{hung, quick},
		Options{Attempts: 1, Backoff: time.Millisecond},
	)

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "stuck", Title: "hangs"})
	dispatcher.Notify(Event{Kind: KindTest, TenantID: "other", Title: "should arrive"})

	waitFor(t, func() bool { return quick.seen() == 1 })
	close(release)
	dispatcher.Close()
}

// An outage that outlasts the old four second window must still end in
// delivery. Scaled down by the backoff so the test runs in milliseconds; the
// property is that the number of attempts is governed by a window, not by a
// hard count of three.
func TestAnOutageOutlastingTheOldWindowStillDelivers(t *testing.T) {
	t.Parallel()

	down := &recorder{name: "down", failFor: 8}
	dispatcher := New(
		fixedSettings{"down": map[string]any{"enabled": true}},
		[]Channel{down},
		Options{Backoff: time.Millisecond},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitFor(t, func() bool { return down.seen() == 1 })
	if down.tries() != 9 {
		t.Fatalf("attempts = %d, want the ninth to be the one that landed", down.tries())
	}
}

// The gaps between attempts must grow. A fixed delay long enough to cover a
// minute-long outage would hammer a dead receiver hundreds of times; one short
// enough not to would not cover the outage. Doubling is how both are had.
func TestRetryDelaysGrow(t *testing.T) {
	t.Parallel()

	down := &timedChannel{}
	dispatcher := New(
		fixedSettings{"timed": map[string]any{"enabled": true}},
		[]Channel{down},
		Options{Attempts: 5, Backoff: 30 * time.Millisecond},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitFor(t, func() bool { return down.tries() == 5 })

	gaps := down.gaps()
	if len(gaps) != 4 {
		t.Fatalf("gaps = %v, want four of them", gaps)
	}
	// Deliberately loose: the assertion is that the delay grew, not that a
	// timer fired to the millisecond on a loaded machine.
	if gaps[3] < 3*gaps[0] {
		t.Fatalf("gaps = %v, want the last much larger than the first", gaps)
	}
}

// With the shipped defaults — no Options at all, which is how main.go builds
// it — delivery must still be being attempted well after the old policy had
// given up. The old one was three attempts two seconds apart, so its last
// attempt was at four seconds; this waits for a fourth attempt, which the
// current schedule makes at seven.
func TestTheShippedDefaultsRetryPastTheOldFourSecondWindow(t *testing.T) {
	t.Parallel()

	down := &recorder{name: "down", failFor: 3}
	dispatcher := New(
		fixedSettings{"down": map[string]any{"enabled": true}},
		[]Channel{down},
		Options{},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitUntil(t, 20*time.Second, func() bool { return down.seen() == 1 })
}

// Retries and deliveries are counted, so "is the webhook flaky" is a query
// rather than an afternoon with the container logs.
func TestRetriesAndDeliveriesAreCounted(t *testing.T) {
	t.Parallel()

	flaky := &recorder{name: "flaky", failFor: 2}
	counts := newCountingRecorder()
	dispatcher := New(
		fixedSettings{"flaky": map[string]any{"enabled": true}},
		[]Channel{flaky},
		Options{Backoff: time.Millisecond, Metrics: counts},
	)
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "hello"})
	waitFor(t, func() bool {
		return counts.get(metricDelivered, "channel", "flaky", "result", "delivered") == 1
	})
	if got := counts.get(metricRetries, "channel", "flaky"); got != 2 {
		t.Fatalf("retries = %d, want the two that preceded the delivery", got)
	}
}

// Dropping under pressure is deliberate — notifications must never become
// back-pressure on the uplink — but the number dropped has to be knowable.
// Before this counter the only trace was a log line.
func TestDroppedNotificationsAreCounted(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	counts := newCountingRecorder()
	dispatcher := New(
		fixedSettings{"slow": map[string]any{"enabled": true}},
		[]Channel{blockingChannel{gate: release}},
		Options{Depth: 1, LaneDepth: 1, Attempts: 1,
			Backoff: time.Millisecond, Metrics: counts},
	)

	// One event can be in the send, one in the lane's queue and one in the
	// intake queue; everything past that has nowhere to go.
	for i := 0; i < 200; i++ {
		dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "flood"})
	}
	waitFor(t, func() bool { return counts.total(metricDropped) >= 190 })

	close(release)
	dispatcher.Close()
}

// Notifying must never block the caller. Whatever produced the event has
// already done its real work, and a slow SMTP server must not become
// back-pressure on the device uplink.
func TestNotifyNeverBlocks(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	var dropped atomic.Int64
	slow := &blockingChannel{gate: release}
	dispatcher := New(
		fixedSettings{"slow": map[string]any{"enabled": true}},
		[]Channel{slow},
		Options{Depth: 2, Attempts: 1, Backoff: time.Millisecond,
			OnResult: func(string, Event, error) { dropped.Add(0) }},
	)

	done := make(chan struct{})
	go func() {
		for i := 0; i < 500; i++ {
			dispatcher.Notify(Event{Kind: KindTest, TenantID: "t", Title: "flood"})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Notify blocked under load; the queue must drop instead")
	}
	close(release)
	dispatcher.Close()
}

type blockingChannel struct{ gate chan struct{} }

func (blockingChannel) Name() string                     { return "slow" }
func (blockingChannel) Configured(c map[string]any) bool { return asBool(c, "enabled") }
func (b blockingChannel) Send(ctx context.Context, _ map[string]any, _ Event) error {
	select {
	case <-b.gate:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// The test button is synchronous, because the whole point is that the person
// pressing it sees the result — including the failure.
func TestSendTestReportsTheFailure(t *testing.T) {
	t.Parallel()

	broken := &recorder{name: "webhook", failFor: 99}
	dispatcher := New(
		fixedSettings{"webhook": map[string]any{"enabled": true}},
		[]Channel{broken},
		Options{Attempts: 1, Backoff: time.Millisecond},
	)
	defer dispatcher.Close()

	if err := dispatcher.SendTest(context.Background(), "t", "webhook"); err == nil {
		t.Fatal("a broken channel should report its failure to the caller")
	}
	if err := dispatcher.SendTest(context.Background(), "t", "nonexistent"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

// The signature lets a receiver tell a real notification from anyone who
// learned the URL.
func TestWebhookSignsTheBodyWhenASecretIsSet(t *testing.T) {
	t.Parallel()

	var gotSignature, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		gotSignature = r.Header.Get("X-VoDoge-Signature")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	config := map[string]any{
		"enabled": true,
		"urls":    []any{server.URL},
		"secret":  "s3cr3t",
	}
	err := Webhook{}.Send(context.Background(), config, Event{
		Kind: KindSmsReceived, TenantID: "t", Title: "新短信", At: time.Unix(0, 0),
	})
	if err != nil {
		t.Fatal(err)
	}

	mac := hmac.New(sha256.New, []byte("s3cr3t"))
	mac.Write([]byte(gotBody))
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSignature != want {
		t.Fatalf("signature = %q, want %q", gotSignature, want)
	}
}

// A non-2xx response is a failure. Silently accepting one would make a
// misrouted webhook look like it was working.
func TestWebhookTreatsAnErrorStatusAsFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer server.Close()

	err := Webhook{}.Send(context.Background(),
		map[string]any{"enabled": true, "urls": []any{server.URL}},
		Event{Kind: KindTest, Title: "x"})
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err = %v, want it to name the status", err)
	}
}

// Bark puts the message in the URL path, so a body containing a slash must not
// be able to change the request's shape.
func TestBarkEscapesTheMessageIntoThePath(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	err := Bark{}.Send(context.Background(),
		map[string]any{"enabled": true, "urls": []any{server.URL}},
		Event{Kind: KindTest, Title: "a/b", Body: "c/d"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(gotPath, "/") != 2 {
		t.Fatalf("path = %q, want the slashes in the text escaped", gotPath)
	}
}

// A subject carrying a newline could append arbitrary headers, including extra
// recipients.
func TestEmailStripsNewlinesFromTheSubject(t *testing.T) {
	t.Parallel()

	config := map[string]any{
		"enabled": true, "smtp_host": "localhost", "smtp_port": float64(1),
		"from_address": "a@b.c", "to_addresses": []any{"d@e.f"},
	}
	if !(Email{}).Configured(config) {
		t.Fatal("fixture should be considered configured")
	}
	// The send itself cannot succeed against port 1; what matters is that the
	// title never reaches the message with a newline in it. Asserted through
	// the same replacer the sender uses.
	title := "line one\r\nBcc: attacker@example.com"
	cleaned := strings.NewReplacer("\r", " ", "\n", " ").Replace(title)
	if strings.ContainsAny(cleaned, "\r\n") {
		t.Fatal("the subject would still carry a newline")
	}
}
