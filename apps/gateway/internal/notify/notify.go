// Package notify delivers events to wherever a tenant asked for them.
//
// The settings page could configure a webhook, an SMTP server and a Bark URL,
// and nothing ever read any of it. Messages arrived, devices went offline and
// backups ran, and the only way to find out was to open the console — which is
// the one thing notifications exist to make unnecessary.
package notify

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Event is something worth telling someone about.
//
// Deliberately small. A notification is a nudge to go and look, not a copy of
// the record — putting message bodies or device state in here would mean the
// tenant's data travelling to whatever third party they configured, on every
// event, forever.
type Event struct {
	Kind     Kind
	TenantID string
	// Title is one line. Body may be several.
	Title string
	Body  string
	// At is when the thing happened, not when the notification was built.
	At time.Time
}

// Kind decides which subscriptions match, and is the label a tenant filters on.
type Kind string

const (
	// KindSmsReceived fires per inbound message.
	KindSmsReceived Kind = "sms.received"
	// KindDeviceOffline fires when a device stops reporting.
	KindDeviceOffline Kind = "device.offline"
	// KindCommandFailed fires when a relayed command comes back failed.
	KindCommandFailed Kind = "command.failed"
	// KindContractViolation fires when a device sends something outside the
	// schema — rare, and the sort of thing that otherwise sits in a log
	// nobody reads.
	KindContractViolation Kind = "contract.violation"
	// KindTest is what the "send a test" button produces.
	KindTest Kind = "test"
)

// Kinds lists every event kind, for the console to render.
func Kinds() []Kind {
	return []Kind{
		KindSmsReceived, KindDeviceOffline, KindCommandFailed,
		KindContractViolation, KindTest,
	}
}

// Channel is one delivery mechanism — a webhook, an SMTP server, a push
// service. Implementations must not retry internally; retry policy belongs to
// the dispatcher so it is the same for every channel.
type Channel interface {
	// Name is the settings key this channel reads, e.g. "webhook".
	Name() string
	// Configured reports whether the tenant has turned this on and given it
	// enough to work with.
	Configured(config map[string]any) bool
	// Send delivers one event. A returned error means the attempt failed;
	// whether that is worth retrying is decided by the caller.
	Send(ctx context.Context, config map[string]any, event Event) error
}

// ErrNotConfigured means the channel is off or missing a required field.
var ErrNotConfigured = fmt.Errorf("channel is not configured")

// Text renders an event as the plain body most channels want.
func Text(event Event) string {
	var out strings.Builder
	out.WriteString(event.Title)
	if event.Body != "" {
		out.WriteString("\n\n")
		out.WriteString(event.Body)
	}
	return out.String()
}

// asString reads a string field, tolerating absence.
func asString(config map[string]any, key string) string {
	value, _ := config[key].(string)
	return strings.TrimSpace(value)
}

// asBool reads a boolean field, where absent means false.
func asBool(config map[string]any, key string) bool {
	value, _ := config[key].(bool)
	return value
}

// asInt reads a whole number, tolerating the float64 that JSON decoding
// produces.
func asInt(config map[string]any, key string) int {
	switch typed := config[key].(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

// asStrings reads a list of strings, skipping blanks.
func asStrings(config map[string]any, key string) []string {
	items, ok := config[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

// section reads a nested channel config, e.g. settings["webhook"].
func section(settings map[string]any, name string) map[string]any {
	nested, _ := settings[name].(map[string]any)
	if nested == nil {
		return map[string]any{}
	}
	return nested
}
