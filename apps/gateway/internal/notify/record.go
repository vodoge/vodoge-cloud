package notify

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// AttemptLog writes down whether one notification reached one channel.
//
// 🔴 在这之前通知**一点痕迹都不留**。命令有 app.command_delivery_attempts
//
//	（0002 起），通知只有 `vodoge_notifications_total` 这个内存计数器 ——
//	它随网关重启清零，而生产上没有任何东西在抓 /metrics。
//
//	代价是具体的：2026-09-11 接通「边缘告警 → 通知」和「墓碑 → 通知」之后，
//	我两次在交付说明里写「投递那一段没法在生产上验证」，因为没有任何持久
//	记录能回答「发出去过没有」。最后是靠重启前后对比内存计数器验的 ——
//	那个办法只在有人正好盯着的那几分钟里有效。
//
// ⚠️ 写失败**不影响通知本身**。这里记的是一次已经发生过的投递，记不下来是
//
//	个损失，但让它去影响下一次投递就是本末倒置。
type AttemptLog struct {
	DB *sql.DB
}

// Record stores one channel's outcome for one event.
func (log AttemptLog) Record(channel string, event Event, sendErr error) {
	if log.DB == nil || event.TenantID == "" {
		return
	}
	result := "delivered"
	var detail any
	if sendErr != nil {
		result = "failed"
		// 通道自己那句话，原样。不归类 —— 上一次靠一句原文定位到问题的是
		// 0065，把它压缩成枚举等于把下一次的线索提前扔掉。
		detail = sendErr.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := tenant.Transact(ctx, log.DB, event.TenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.notification_attempts
				(tenant_id, kind, channel, result, detail, attempted_at)
			VALUES ($1::uuid, $2, $3, $4, $5, now())`,
			event.TenantID, string(event.Kind), channel, result, detail)
		return err
	})
	if err != nil {
		// ⚠️ 只落日志。见类型注释：记不下来是损失，影响下一次投递是本末倒置。
		slog.Warn("notification attempt not recorded",
			"tenant_id", event.TenantID, "channel", channel,
			"kind", string(event.Kind), "error", err)
	}
}
