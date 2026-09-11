-- 通知发出去没有，系统一点痕迹都不留。
--
-- 🔴 命令有 `app.command_delivery_attempts`（0002 起），通知什么都没有：
--    唯一的记录是 `vodoge_notifications_total` 这个**内存计数器**，它随网关
--    重启清零，而生产上**没有任何东西在抓 /metrics**（compose 里只有
--    postgres / redis / migrate / gateway / console / admin，没有采集方）。
--
--    代价我自己撞到过两次：2026-09-11 接通「边缘告警 → 通知」和「墓碑 →
--    通知」之后，我两次在交付说明里写「投递那一段没法在生产上验证」——
--    因为没有任何持久记录能回答「发出去过没有」。
--
--    最后是靠**重启网关前后对比内存计数器**验的（当天 pushplus/telegram 各
--    delivered 3、webhook failed 2）。那个办法只在有人正好盯着的那几分钟里
--    有效，而且重启一次就归零。
--
-- ⚠️ 四种丢弃理由（queue_full / lane_full / lane_limit / settings_unavailable）
--    今天全是静默的：只有一个没人读的计数器 +
--    一行 `slog.Warn`。通知通道自己的失败**没法靠通知来报**，所以它需要
--    另一个读者 —— 这张表就是那个读者能读的东西。
--
-- ## 形状照 `app.command_delivery_attempts`
--
-- 不发明新概念：命令那一侧「每次投递尝试一行」的形状已经在那里，这张表是
-- 它在通知这一侧的对应物。
--
-- ⚠️ **不存正文**。通知的 body 里有设备 id、故障原文、短信对端 —— 那些在
--    `app.alerts` / `app.messages` 里已经有了，在这里再存一份只是多一处
--    泄露面。这张表回答的是「发没发出去」，不是「发了什么」。
BEGIN;

CREATE TABLE IF NOT EXISTS app.notification_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    -- 事件种类（notify.Kind），例如 sms.received / edge.alert / record.dropped。
    kind text NOT NULL,
    -- 通道名（webhook / telegram / pushplus / bark / email / feishu / wecom）。
    channel text NOT NULL,
    -- 'delivered' 或 'failed'。刻意只有两种：这张表回答「发没发出去」。
    result text NOT NULL,
    -- 失败时通道自己那句话，原样。成功时为 NULL。
    --
    -- 🔴 原样存，不归类。上一次靠一句原文定位到问题的是 0065（投递回执那次），
    --    把它压缩成一个枚举等于把下一次的诊断线索提前扔掉。
    detail text,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_attempts_result_valid
        CHECK (result = ANY (ARRAY['delivered', 'failed']))
);

-- 🔴 属主必须是 vodoge_owner。
--
-- 2026-09-10 我给 app.modem_registry 漏了这一行，边缘上行连续 2 分 40 秒
-- 全部 `permission denied`（见 0066）。这张表虽然不在 SECURITY DEFINER 的
-- 写入链上（网关直接以 vodoge_gateway 身份写），但 schema 里其余 32 张表都
-- 归 vodoge_owner，留一张不一致的就是给下一个人留一个陷阱。
ALTER TABLE app.notification_attempts OWNER TO vodoge_owner;

ALTER TABLE app.notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.notification_attempts;
CREATE POLICY tenant_isolation ON app.notification_attempts
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT ON app.notification_attempts TO vodoge_app;

-- 查「最近发出去的是什么」和「最近失败的是什么」都走这一个索引。
CREATE INDEX IF NOT EXISTS notification_attempts_recent
    ON app.notification_attempts (tenant_id, attempted_at DESC);

-- ⚠️ 没有保留期清理。
--
-- 一条通知对应几行（一个通道一行），而通知本身是稀疏的 —— 生产上 10 天里
-- 一共发了 3 次。按这个速率它不会长大。等到它真的长大了（比如接了
-- sms.received 且短信量上来），那时候加清理才有依据；现在加一个凭空定的
-- 保留期，只会在某天悄悄删掉一段正要用来查问题的历史。
-- `app.delete_device` 不删它：通知不属于任何一台设备。

COMMIT;
