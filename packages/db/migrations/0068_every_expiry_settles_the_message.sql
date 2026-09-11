-- 0067 只补了三个过期函数里的一个，而漏掉的那个正是定时器在走的那条。
--
-- 🔴 0067 给 `app.expire_overdue_commands` 加了「命令过期 → 短信落地」，并把
--    生产上那 3 条卡了 20 天的 queued 补掉了。但生产上有**三个**过期函数：
--
--      app.expire_overdue_commands         0067 补了
--      app.expire_overdue_tenant_commands  **漏了** —— scheduler 定时扫的就是它
--      app.expire_command                  漏了 —— 今天只有测试在调
--
--    `expire_overdue_tenant_commands` 的接线在 apps/gateway/cmd/gateway/main.go
--    （`proc.sweep = pending.ExpireTenantCommands` → internal/commands/
--    lifecycle.go 的 `SELECT app.expire_overdue_tenant_commands($1, $2)`）。
--    也就是说 0067 上线之后，**定时器每一轮仍然会生产新的卡住的 queued 行** ——
--    补了历史数据，没堵住来源。
--
-- ⚠️ 0067 的测试为什么没抓住：它只调了 `expire_overdue_commands` 一个函数。
--    一条只覆盖一个入口的断言，在有三个入口的地方等于没覆盖。这次配套的测试
--    改成**从 pg_proc 把过期函数数出来**，每一个都要求它提到 app.messages ——
--    将来再多一个入口，那条断言会自己变红。
--
-- ⚠️ 顺带更正 0067 头注释里的一处出处：`expire_overdue_commands` 是
--    `0033_expire_overdue_commands.sql` 建的，`0037_settle_command_accounting.sql`
--    只是重写了它（把 'accepted' 纳进 WHERE）。0067 写成「0037」，不准确。
--
-- 函数体照旧从生产 `pg_get_functiondef` 原样拉下来打补丁（同 0062-0067）。
-- `CREATE OR REPLACE` 不改属主。
BEGIN;

-- ① 定时器走的那条。和 0067 改的那个同构，只少一个 device 过滤。
CREATE OR REPLACE FUNCTION app.expire_overdue_tenant_commands(
    p_tenant_id uuid,
    p_now timestamp with time zone DEFAULT now()
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
    v_expired integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command expiry tenant'
            USING ERRCODE = '42501';
    END IF;

    WITH overdue AS (
        UPDATE app.commands AS c
        SET status = 'expired',
            completed_at = p_now,
            updated_at = now(),
            result = jsonb_build_object(
                'status', 'expired',
                'completed_at', p_now,
                'attempts', 0,
                'reason_code', CASE
                    WHEN c.status = 'accepted' THEN 'cloud_expired_after_accept'
                    ELSE 'cloud_expired'
                END
            )
        WHERE c.tenant_id = p_tenant_id
          AND c.status IN ('queued', 'dispatched', 'accepted')
          AND c.expires_at <= p_now
        RETURNING c.id, c.result ->> 'reason_code' AS reason_code
    ),
    resolved AS (
        UPDATE app.command_outbox AS o
        SET resolved_at = COALESCE(o.resolved_at, p_now),
            status = 'published',
            lease_owner = NULL,
            lease_expires_at = NULL
        FROM overdue
        WHERE o.tenant_id = p_tenant_id
          AND o.command_id = overdue.id
          AND o.resolved_at IS NULL
        RETURNING o.id
    ),
    -- 和 0067 里那段字字相同。两处必须说同一句话：运维看到的文案不该取决于
    -- 是哪一条扫路先碰到它。
    settled AS (
        UPDATE app.messages AS m
        SET status = 'failed',
            failure_reason = COALESCE(
                m.failure_reason,
                CASE overdue.reason_code
                    WHEN 'cloud_expired_after_accept' THEN
                        '云端等到超时就不再等了。这台设备**接受过**这条命令，'
                        '所以这条短信可能已经真的发出去了 —— 重发之前先查投递回执。'
                    ELSE
                        '云端等到超时就不再等了。这台设备从来没有接过这条命令，'
                        '所以这条短信没有发出去，可以直接重发。'
                END
            )
        FROM overdue
        -- 🔴 自己过滤 tenant_id。这个函数是 SECURITY DEFINER，属主 `vodoge`
        --    （superuser + BYPASSRLS），所以 app.messages 上的 FORCE RLS 在这里
        --    完全不生效 —— 顶部那个 current_tenant_id 检查是唯一的租户守卫。
        WHERE m.tenant_id = p_tenant_id
          AND m.command_id = overdue.id
          AND m.direction = 'outbound'
          AND m.status = 'queued'
        RETURNING m.id
    )
    SELECT count(*) INTO v_expired FROM overdue;

    RETURN v_expired;
END
$function$;

-- ② 单条命令的那个。今天生产上没有 Go 调用者（只有
--    packages/db/tests/command_dispatch_lifecycle.sql 在调），所以它不是那 3 条
--    卡住的来源。补它的理由是**一致性**：三个函数做同一件事而其中一个不结算
--    消息，就是给下一个接线的人留一个陷阱。
--
-- ⚠️ 这一版和上面两个不同：它返回 boolean、参数叫 `p_expired_at`、用
--    `FOR UPDATE` 锁行、只收 queued/dispatched（**不收 accepted**），而且
--    reason_code 恒为 'cloud_expired'。
--
-- 🔴 我第一版是凭理解重写的，和真函数差得很远（返回类型、参数名、锁、
--    收哪些状态全都不对）。这里改成照 `pg_get_functiondef` 的原文打补丁 ——
--    0065 的注释就是为这件事写的：照的必须是当前生效的那一版。
--
-- 因为它不收 'accepted'，这条路上的命令一定是**没被设备接过**的，所以那句话
-- 只有一种：可以直接重发。不写 CASE，写一个恒定的分支反而更诚实 ——
-- 一个永远走不到的 else 分支会让读者以为这里有两种情形。
CREATE OR REPLACE FUNCTION app.expire_command(
    p_tenant_id uuid,
    p_command_id uuid,
    p_expired_at timestamp with time zone DEFAULT now()
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
    v_command app.commands%ROWTYPE;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command expiry tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_expired_at IS NULL THEN
        RAISE EXCEPTION 'command expiry time is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_command
    FROM app.commands
    WHERE tenant_id = p_tenant_id
      AND id = p_command_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'command not found for tenant'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_command.status NOT IN ('queued', 'dispatched')
        OR v_command.expires_at > p_expired_at THEN
        RETURN false;
    END IF;

    UPDATE app.commands
    SET status = 'expired',
        completed_at = p_expired_at,
        result = jsonb_build_object(
            'status', 'expired',
            'completed_at', p_expired_at,
            'attempts', 0,
            'reason_code', 'cloud_expired'
        )
    WHERE tenant_id = p_tenant_id
      AND id = p_command_id;

    UPDATE app.command_outbox
    SET resolved_at = COALESCE(resolved_at, p_expired_at),
        status = CASE WHEN status = 'leased' THEN 'published' ELSE status END,
        lease_owner = NULL,
        lease_expires_at = NULL
    WHERE tenant_id = p_tenant_id
      AND command_id = p_command_id
      AND resolved_at IS NULL;

    -- 这次加的那一段。理由和文案同 0067。
    --
    -- 🔴 自己过滤 tenant_id：SECURITY DEFINER + 属主 `vodoge`（superuser +
    --    BYPASSRLS），FORCE RLS 在这里不生效。
    UPDATE app.messages AS m
    SET status = 'failed',
        failure_reason = COALESCE(
            m.failure_reason,
            '云端等到超时就不再等了。这台设备从来没有接过这条命令，'
            '所以这条短信没有发出去，可以直接重发。'
        )
    WHERE m.tenant_id = p_tenant_id
      AND m.command_id = p_command_id
      AND m.direction = 'outbound'
      AND m.status = 'queued';

    RETURN true;
END
$function$;

COMMIT;
