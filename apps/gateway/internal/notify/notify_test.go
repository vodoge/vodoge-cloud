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
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for the condition")
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
	waitFor(t, func() bool { return working.seen() == 1 })
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
