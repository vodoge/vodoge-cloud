package notify

import (
	"context"
	"database/sql"
	"sort"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Attempt is one recorded delivery, as app.notification_attempts holds it.
type Attempt struct {
	Channel string
	// "delivered" 或 "failed"。表上有 CHECK 约束，这里不再重复校验。
	Result string
	At     time.Time
	// 失败时通道自己那句话，原样。成功时空。
	Detail string
}

// ChannelHealth is one channel's recent record, as an operator needs it.
//
// ⚠️ 汇总而不是原样列出：要回答的问题是「这条渠道还活着吗」，不是「第 37 次失败
//
//	的报文长什么样」。后者在 `detail` 里，要查的时候再去查。
//
// ⚠️ 显式 JSON tag。没有它字段会按 Go 的大驼峰上线（`ConsecutiveFailures`），
//
//	而这个仓库整条线用的是 snake_case —— 控制台那一侧照着抄一次大驼峰，就成了
//	第二处会分家的地方。`packages/contract` 里每一个上线类型都是这么定的。
type ChannelHealth struct {
	// 最近一次成功之后失败了几次。0 = 最近一次是成功的。
	ConsecutiveFailures int `json:"consecutive_failures"`
	// 最近一次成功的时刻，`nil` = 这条渠道在记录范围内**从来没成功过**。
	//
	// 🔴 指针而不是零值时间：「从没成功过」和「1970 年成功过」必须能分开。
	//    生产上 webhook 就是前者，而它正是这个功能要让人看见的那一条。
	LastSuccess *time.Time `json:"last_success"`
	// 最近一次失败时通道自己那句话。
	//
	// 🔴 带原文，不归类。生产上那 40 次失败的原文都是
	//    `dial tcp: lookup hooktest` —— 那一句直接说明是配置写错了，
	//    压成「投递失败」就得有人再去翻库。同 0069 里那条注释的理由。
	LastDetail string `json:"last_detail"`
	// 记录范围内这条渠道一共尝试过几次。分母，没有它「失败 3 次」读不出轻重。
	Total int `json:"total"`
	// 这条渠道的记录**占满了**读取窗口 —— 也就是说更早的记录被截断了。
	//
	// 🔴 `LastSuccess == nil && WindowFull` 的意思是「窗口里没看到成功」，
	//    **不是**「从来没成功过」。两者的下一步完全不同：一个是配置从没对过，
	//    一个是刚刚坏掉。对抗复核抓到的第一版把两者显示成同一句话。
	//
	//    缺席 ≠ 空：窗口看不到，不等于不存在。
	WindowFull bool `json:"window_full"`
}

// Summarise folds attempts into one row per channel.
//
// ⚠️ 自己按时间排序，不信调用方的顺序：一个按渠道分组的查询会把两条渠道交错着
//
//	交出来，而「连续失败」是按时间数的。
//
// 🔴 一次尝试都没有的渠道**不出现**在结果里，而不是显示成「0 次失败」。
//
//	缺席 ≠ 空：「从没发过」和「发过而且都成功」是两件事，把前者画成一片绿色
//	正是这个功能要避免的那种谎。调用方拿设置里配了哪些渠道去对，就能把
//	「配了但从没发过」单独说出来。
//
// Summarise folds attempts with no knowledge of the read window.
//
// ⚠️ 等价于 `SummariseWindow(attempts, 0)`：窗口未知时 `WindowFull` 一律为 false,
//
//	也就是「按看到的说」。调用方知道窗口大小的话应当用 `SummariseWindow` ——
//	生产那条路就是。
func Summarise(attempts []Attempt) map[string]ChannelHealth {
	return SummariseWindow(attempts, 0)
}

// SummariseWindow folds attempts, knowing how many rows per channel were read.
func SummariseWindow(attempts []Attempt, perChannelLimit int) map[string]ChannelHealth {
	byChannel := map[string][]Attempt{}
	for _, attempt := range attempts {
		byChannel[attempt.Channel] = append(byChannel[attempt.Channel], attempt)
	}

	health := make(map[string]ChannelHealth, len(byChannel))
	for channel, rows := range byChannel {
		sort.Slice(rows, func(i, j int) bool { return rows[i].At.After(rows[j].At) })

		entry := ChannelHealth{
			Total: len(rows),
			// 取到的条数等于上限 = 更早的被截断了。等于而不是大于:SQL 那一侧
			// 用 `row_number() <= limit`,不会多给。
			WindowFull: perChannelLimit > 0 && len(rows) >= perChannelLimit,
		}
		counting := true
		for _, row := range rows {
			if row.Result == "delivered" {
				counting = false
				if entry.LastSuccess == nil {
					at := row.At
					entry.LastSuccess = &at
				}
				continue
			}
			if entry.LastDetail == "" {
				entry.LastDetail = row.Detail
			}
			if counting {
				entry.ConsecutiveFailures++
			}
		}
		health[channel] = entry
	}
	return health
}

// RecentAttempts reads one tenant's delivery record.
//
// `limit` 是每条渠道的上限，不是总数 —— 一条每分钟都在失败的渠道，不该把另一条
// 每天发一次的渠道挤出窗口。
func (log AttemptLog) RecentAttempts(
	ctx context.Context,
	tenantID string,
	limit int,
) ([]Attempt, error) {
	if log.DB == nil || tenantID == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 50
	}
	var attempts []Attempt
	err := tenant.Transact(ctx, log.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT channel, result, attempted_at, coalesce(detail, '')
			  FROM (
			      SELECT channel, result, attempted_at, detail,
			             row_number() OVER (PARTITION BY channel
			                                ORDER BY attempted_at DESC) AS rank
			        FROM app.notification_attempts
			  ) ranked
			 WHERE rank <= $1
			 ORDER BY attempted_at DESC`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var attempt Attempt
			if err := rows.Scan(&attempt.Channel, &attempt.Result,
				&attempt.At, &attempt.Detail); err != nil {
				return err
			}
			attempts = append(attempts, attempt)
		}
		return rows.Err()
	})
	return attempts, err
}
