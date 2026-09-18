-- 「这台设备从来没有接过这条命令，所以这条短信没有发出去，可以直接重发。」
-- —— 这句话的后半截没有依据，而它正是生产上唯一在说的那一句。
--
-- 🔴 三件事凑在一起：
--
--   ① 边缘是**先执行、后发回执**的（edge-bin 的 handle_command：
--      `handle_envelope()` 里已经把 PDU 交给模组了，之后才
--      `socket.send_envelope(CommandReceipt)`）；
--   ② `CommandReceipt` 是 `seq: None`，**不进设备的落盘队列** —— 帧丢了就永远
--      丢了，重连也不会重放（`CommandResult` 是 Protected，会重放，回执不是）；
--   ③ 网关**从不**调用 `app.record_command_delivery_attempt`，所以命令即使被
--      推送过很多次，状态也一直停在 'queued'，从来不会变成 'dispatched'。
--
-- 于是「设备执行完就掉线」这条路上：短信已经交给模组，回执丢了，云端看到的是
-- 一条从没被接受过的命令，过期时写下「这条短信没有发出去，可以直接重发」——
-- 而运维照做就是再花一次钱，收件人收到两条。
--
-- 生产实测（2026-09-18）：12 条过期命令**全部**是这一支（reason_code =
-- 'cloud_expired'，accepted_at 全空）；另一支 'cloud_expired_after_accept'
-- 一次都没有发生过。也就是说这句假话是唯一在生产上说过的那一句。
--
-- ⚠️ 这次只改文案，不改状态机。要把话说得更准，需要网关在首次推送时把命令标成
--    'dispatched'（那样就能分开「从没推送过」和「推送过但没收到回执」两种情形，
--    前者确实可以直接重发）。那是一次行为改动 + 一次界面文案改动，留给下一步。
--
-- ⚠️ 三个函数都改：expire_command / expire_overdue_commands /
--    expire_overdue_tenant_commands。0068 自己的注释就写着「两处必须说同一句话：
--    运维看到的文案不该取决于是哪一条扫路先碰到它」—— 现在是三处。
--
-- 函数体取自生产上的现定义（pg_get_functiondef），除这一句外逐字未动。

BEGIN;

CREATE OR REPLACE FUNCTION app.expire_command(p_tenant_id uuid, p_command_id uuid, p_expired_at timestamp with time zone DEFAULT now())
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
            '云端等到超时就不再等了。云端没有收到这台设备的接收回执，'
            '而接收回执不重传 —— 所以这不能证明短信没有发出去。'
            '重发之前先查投递回执。'
        )
    WHERE m.tenant_id = p_tenant_id
      AND m.command_id = p_command_id
      AND m.direction = 'outbound'
      AND m.status = 'queued';

    RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION app.expire_overdue_commands(p_tenant_id uuid, p_device_id uuid, p_now timestamp with time zone DEFAULT now())
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
                -- c.status here is the pre-update value, so the code records
                -- how far the command actually got before the cloud gave up.
                'reason_code', CASE
                    WHEN c.status = 'accepted' THEN 'cloud_expired_after_accept'
                    ELSE 'cloud_expired'
                END
            )
        WHERE c.tenant_id = p_tenant_id
          AND c.device_id = p_device_id
          AND c.status IN ('queued', 'dispatched', 'accepted')
          AND c.expires_at <= p_now
        -- reason_code 要带出去：下面那段靠它决定对运维说哪一句话。
        -- RETURNING 里引用的是**更新后**的行，所以这就是刚写下的那个值。
        RETURNING c.id, c.result ->> 'reason_code' AS reason_code
    ),
    -- A data-modifying CTE runs whether or not anything selects from it, so
    -- the outbox is resolved even though only the count is read below.
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
    -- 命令死了，那条短信得跟着落地。
    --
    -- 🔴 这一段是这次加的。没有它，消息永远停在 `queued`，而控制台上
    --    「排队中」读起来像「马上就发」。
    settled AS (
        UPDATE app.messages AS m
        SET status = 'failed',
            -- COALESCE：绝不覆盖一条更具体的原因。边缘那边写下来的
            -- （「QMI transport error: …」之类）比这句泛化的话有用得多。
            failure_reason = COALESCE(
                m.failure_reason,
                CASE overdue.reason_code
                    WHEN 'cloud_expired_after_accept' THEN
                        '云端等到超时就不再等了。这台设备**接受过**这条命令，'
                        '所以这条短信可能已经真的发出去了 —— 重发之前先查投递回执。'
                    ELSE
                        '云端等到超时就不再等了。云端没有收到这台设备的接收回执，'
                        '而接收回执不重传 —— 所以这不能证明短信没有发出去。'
                        '重发之前先查投递回执。'
                END
            )
        FROM overdue
        WHERE m.tenant_id = p_tenant_id
          AND m.command_id = overdue.id
          AND m.direction = 'outbound'
          -- 只动还没落地的那一种。`sent` 是命令 succeeded 才会有的状态，
          -- 而 succeeded 的命令进不了上面那个 WHERE —— 把它纳进来就是在猜。
          AND m.status = 'queued'
        RETURNING m.id
    )
    SELECT count(*) INTO v_expired FROM overdue;

    RETURN v_expired;
END
$function$;

CREATE OR REPLACE FUNCTION app.expire_overdue_tenant_commands(p_tenant_id uuid, p_now timestamp with time zone DEFAULT now())
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
                        '云端等到超时就不再等了。云端没有收到这台设备的接收回执，'
                        '而接收回执不重传 —— 所以这不能证明短信没有发出去。'
                        '重发之前先查投递回执。'
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

COMMIT;
