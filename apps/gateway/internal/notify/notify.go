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
	// KindBackupFailed fires when a scheduled dump does not complete.
	//
	// Unlike every other kind this one is not about a device, and nothing
	// inside a request produces it: the dump runs from a timer with no tenant
	// context at all. It arrives through the ops endpoint, addressed to
	// whichever tenant is configured to receive operational alerts.
	KindBackupFailed Kind = "backup.failed"
	// KindEdgeAlert fires for a fault the agent itself reported.
	//
	// 🔴 app.alerts 是 0053 建的，那份迁移开头写着这张表的理由：
	//    「a fault nobody thinks to look for is a fault nobody hears about」，
	//    还有「行数已经等于**应该被告知的次数**」。而它从建表那天起就没有
	//    出口：告警由一个数据库触发器投影进表，网关这一侧的 Go 代码里
	//    连「Alert」这个概念都没有。2026-09-11 在生产上查到 263 条告警，
	//    一条都没有变成通知。
	KindEdgeAlert Kind = "edge.alert"
	// KindTest is what the "send a test" button produces.
	KindTest Kind = "test"
)

// AlertLevelNotifies decides whether an edge-reported level is worth a push.
//
// 🔴 这条线是拿生产上的真实速率定的（2026-09-11，10 天窗口）：
//
//	warning  242 条  每天 24.2
//	error     21 条  每天  2.1
//
// 推 warning 就是每天二十多条推送，而那不是「更灵敏」，那是**训练运维忽略
// 这个通道** —— 一个被忽略的通道和没有通道是同一件事，只是更难发现。
// warning 仍然在控制台上看得见。
//
// ⚠️ `critical` 必须在里面。第一版我只写了 `level != "error" 就 return`，
// 而契约的枚举是 [info, warning, error, critical]，边缘有三个 critical 的
// code（capability_matrix_unparsed、retro_would_unbind、retro_unbound），
// 其中 retro_would_unbind 正是**默认 mark 模式**下会发的那一个。生产上还
// 没发过，所以那个漏洞在屏幕上完全看不出来 —— 它会在最该响的那一次沉默。
//
// 未知的 level 也推。契约那个枚举将来多一档时，宁可多响一次也不要漏掉一个
// 比 error 更严重的新等级 —— 这个方向的错代价小得多。
func AlertLevelNotifies(level string) bool {
	switch level {
	case "info", "warning":
		return false
	default:
		return true
	}
}

// Kinds lists every event kind, for the console to render.
func Kinds() []Kind {
	return []Kind{
		KindSmsReceived, KindDeviceOffline, KindCommandFailed,
		KindEdgeAlert,
		KindContractViolation, KindBackupFailed, KindTest,
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
