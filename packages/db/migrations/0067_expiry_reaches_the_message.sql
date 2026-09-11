-- 命令过期了，那条短信却永远留在「排队中」。
--
-- 🔴 生产上一对一地坐实过（2026-09-11）：
--
--      app.commands  kind='send_sms'  status='expired'   3 条
--      app.messages  direction='outbound' status='queued' 3 条
--
--    三对三，`command_id` 一一对应，最早 2026-08-22、最晚 2026-08-27 ——
--    也就是说有人 20 天前按下「发送」，那条短信至今在控制台上显示「排队中」。
--    而它永远不会再动：命令已经到了终态（expired），而
--    `app.expire_overdue_commands`（0037）**一次都没有提到 app.messages**。
--
--    三条的 reason_code 全是 `cloud_expired`、`accepted_at` 和
--    `dispatched_at` 都是 NULL —— 设备从来没有接过它们，所以这几条短信
--    **肯定没有发出去**。
--
-- ## 为什么写 failed，以及那句话为什么要带上不确定性
--
-- 过期分两种，0037 自己就分开记了：
--
--   `cloud_expired`              设备没接过 —— 肯定没发出去
--   `cloud_expired_after_accept` 设备接过 —— 可能真发出去了
--
-- 两种都写 `failed`（这条命令死了，云端不会再把它送出去），但
-- `failure_reason` 里的句子不一样：后一种必须说出「可能已经发出去了，
-- 重发之前先查投递回执」。这不是我发明的写法，是这个仓库已有的先例 ——
-- 生产上有两行 failure_reason 是：
--
--   「…the request had already been handed over. The message was already
--     handed to the module, so it may have been transmitted; check for a
--     delivery receipt before sending it again.」
--
-- 把两种合成一句，代价是运维对一条可能已经到达对方手机的短信按了重发。
--
-- ## 只动 `queued`
--
-- 刻意不碰 `sent`。一条消息变成 `sent` 是因为命令 **succeeded**，而
-- succeeded 的命令不会出现在过期那个 WHERE 里（它只看
-- queued/dispatched/accepted）。把 `sent` 一起纳入，就是在猜一件这个函数
-- 没有依据的事。
--
-- ⚠️ 生产上另有 4 条消息卡在 `sent`（08-22），它们的命令都是 succeeded、
--    `provider_reference` 却是 NULL —— 投递回执靠那个引用匹配，所以它们
--    结构上永远匹配不到任何回执。那是 08-23 引用记录生效**之前**的历史
--    数据（之后的 73 条全部有引用），不是一个活着的缺陷。要不要给它们一个
--    终态是一次数据决定，不该由这个迁移顺手做。
--
-- ## 两处必须自己做的事
--
-- 🔴 新加的那段**自己过滤 tenant_id**，不依赖 RLS。这个函数是 SECURITY
--    DEFINER，属主 `vodoge`，而 `vodoge` 是 superuser + BYPASSRLS ——
--    也就是说 app.messages 上的 FORCE RLS 在这里**完全不生效**，函数顶部
--    那个 `p_tenant_id IS DISTINCT FROM app.current_tenant_id()` 是唯一的
--    租户守卫。少写一个 tenant_id 条件，就是跨租户改数据。
--
-- ⚠️ 顺带记一处不一致：`accept_ingress` 的属主是 `vodoge_owner`（非
--    superuser），而这个函数的属主是 `vodoge`（superuser）。也就是说它以
--    最高权限运行。改属主不在这个迁移里做 —— 2026-09-10 我改一个
--    SECURITY DEFINER 链上的属主，造成了 2 分 40 秒的全线上行失败
--    （见 0066 的注释）。那是一次单独的决定。
--
-- 函数体是从生产库 `pg_get_functiondef` 原样拉下来打的补丁（同 0062-0066）。
-- `CREATE OR REPLACE` 不改属主，所以它仍然归 `vodoge`。
BEGIN;

CREATE OR REPLACE FUNCTION app.expire_overdue_commands(
    p_tenant_id uuid,
    p_device_id uuid,
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
                        '云端等到超时就不再等了。这台设备从来没有接过这条命令，'
                        '所以这条短信没有发出去，可以直接重发。'
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

-- 把已经卡住的那几条补上。
--
-- 🔴 只补「命令已过期、消息还在 queued」这一种，所以它是幂等的：再跑一次
--    一行都不会动。也刻意**不碰** `sent` 那 4 条（理由在文件开头）。
--
-- ⚠️ 这一段跑在迁移里，执行者是 `vodoge`（superuser，绕过 RLS），所以它会
--    跨所有租户补 —— 这是这里想要的行为（补历史数据），但正因为 RLS 不生效，
--    条件必须自己写严。
WITH stuck AS (
    SELECT m.id,
           c.result ->> 'reason_code' AS reason_code
      FROM app.messages AS m
      JOIN app.commands AS c ON c.id = m.command_id
     WHERE m.direction = 'outbound'
       AND m.status = 'queued'
       AND c.status = 'expired'
)
UPDATE app.messages AS m
   SET status = 'failed',
       failure_reason = COALESCE(
           m.failure_reason,
           CASE stuck.reason_code
               WHEN 'cloud_expired_after_accept' THEN
                   '云端等到超时就不再等了。这台设备**接受过**这条命令，'
                   '所以这条短信可能已经真的发出去了 —— 重发之前先查投递回执。'
               ELSE
                   '云端等到超时就不再等了。这台设备从来没有接过这条命令，'
                   '所以这条短信没有发出去，可以直接重发。'
           END
       )
  FROM stuck
 WHERE m.id = stuck.id;

COMMIT;
