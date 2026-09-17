package notify

import (
	"testing"
	"time"
)

// 一条渠道连续失败了多少次、最后一次成功是什么时候。
//
// 🔴 这个函数存在的理由，是生产上量到的一件事：webhook 连续失败 **40 次**
//
//	（40 / 40），而 pushplus 和 telegram 各 40 次全部成功。失败原因每一次都一样：
//	配的是 `http://hooktest:19999/hook`，一个解析不了的占位主机。
//
//	而控制台上那条渠道显示的是「已启用」。`app.notification_attempts` 早就把每
//	一次都记下来了 —— 那张表是这一轮加的，理由正是「通知发出去没有，系统一点
//	痕迹都不留」—— 但它**只有写入者，没有任何读者**。痕迹有了，没人看。
//
// ⚠️ 汇总而不是原样列出：运维要回答的问题是「这条渠道还活着吗」，不是「第 37 次
//
//	失败的报文长什么样」。后者在 detail 里，要查的时候再去查。
func TestAChannelThatNeverSucceedsIsVisible(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 17, 14, 0, 0, 0, time.UTC)
	attempts := []Attempt{
		{Channel: "webhook", Result: "failed", At: now.Add(-3 * time.Minute), Detail: "dial tcp: lookup hooktest"},
		{Channel: "webhook", Result: "failed", At: now.Add(-2 * time.Minute), Detail: "dial tcp: lookup hooktest"},
		{Channel: "webhook", Result: "failed", At: now.Add(-1 * time.Minute), Detail: "dial tcp: lookup hooktest"},
		{Channel: "telegram", Result: "delivered", At: now.Add(-1 * time.Minute)},
	}

	health := Summarise(attempts)

	webhook, ok := health["webhook"]
	if !ok {
		t.Fatal("webhook 不在汇总里")
	}
	if webhook.ConsecutiveFailures != 3 {
		t.Fatalf("连续失败 = %d，期望 3", webhook.ConsecutiveFailures)
	}
	if webhook.LastSuccess != nil {
		t.Fatalf("从来没成功过，LastSuccess 应当是 nil，拿到 %v", webhook.LastSuccess)
	}
	// 🔴 原文要带出来。一句 "dial tcp: lookup hooktest" 直接说明是配置写错了；
	//    压成「投递失败」就得有人再去翻库。
	if webhook.LastDetail == "" {
		t.Fatal("最后一次失败的原文没带出来 —— 那句话就是诊断本身")
	}

	telegram, ok := health["telegram"]
	if !ok {
		t.Fatal("telegram 不在汇总里")
	}
	if telegram.ConsecutiveFailures != 0 {
		t.Fatalf("telegram 一直成功，连续失败应当是 0，拿到 %d", telegram.ConsecutiveFailures)
	}
	if telegram.LastSuccess == nil {
		t.Fatal("telegram 成功过，LastSuccess 不该是 nil")
	}
}

// 负面对照：一条**恢复了**的渠道不能一直报警。
//
// 🔴 少了这一条，"连续失败 = 总失败次数" 也能让上面那条变绿 —— 而那样一条修好
//
//	的渠道会永远显示成坏的，于是没有人再看这个指标。一道永远亮着的灯不是告警。
func TestAChannelThatRecoveredStopsCounting(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 17, 14, 0, 0, 0, time.UTC)
	health := Summarise([]Attempt{
		{Channel: "webhook", Result: "failed", At: now.Add(-5 * time.Minute)},
		{Channel: "webhook", Result: "failed", At: now.Add(-4 * time.Minute)},
		{Channel: "webhook", Result: "delivered", At: now.Add(-3 * time.Minute)},
		{Channel: "webhook", Result: "failed", At: now.Add(-2 * time.Minute)},
	})

	if got := health["webhook"].ConsecutiveFailures; got != 1 {
		t.Fatalf("最近一次成功之后只失败了一次，期望 1，拿到 %d", got)
	}
	if health["webhook"].LastSuccess == nil {
		t.Fatal("中间成功过，LastSuccess 不该是 nil")
	}
}

// 顺序不能靠输入的顺序。
//
// ⚠️ SQL 那一侧是 `ORDER BY attempted_at DESC`，但汇总不该假设调用方一定排好了 ——
//
//	一个按渠道分组的查询会把两条渠道交错着交出来，而「连续失败」是**按时间**数的。
func TestSummarisingDoesNotTrustTheInputOrder(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 17, 14, 0, 0, 0, time.UTC)
	health := Summarise([]Attempt{
		{Channel: "webhook", Result: "failed", At: now.Add(-1 * time.Minute)},
		{Channel: "webhook", Result: "delivered", At: now.Add(-9 * time.Minute)},
		{Channel: "webhook", Result: "failed", At: now.Add(-2 * time.Minute)},
	})

	if got := health["webhook"].ConsecutiveFailures; got != 2 {
		t.Fatalf("按时间最近两次都是失败，期望 2，拿到 %d", got)
	}
}

// 一次尝试都没有的渠道，不出现在汇总里 —— 而不是显示成「0 次失败」。
//
// 🔴 缺席 ≠ 空。「从没发过」和「发过而且都成功」是两件事，把前者显示成一片绿色
//
//	正是这个功能要避免的那种谎。
func TestAChannelWithNoAttemptsIsAbsentRatherThanGreen(t *testing.T) {
	t.Parallel()

	health := Summarise(nil)
	if len(health) != 0 {
		t.Fatalf("没有任何尝试却汇总出 %d 条", len(health))
	}
}
