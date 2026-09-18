-- 过期结算不许断言「这条短信没有发出去」。
--
-- 🔴 云端不知道这件事，而它曾经这么说。三件事凑在一起让那句话变成假的：
--
--    ① 边缘是**先执行、后发回执**的（edge-bin 的 handle_command）；
--    ② `CommandReceipt` 是 `seq: None`、不进设备的落盘队列 —— 帧丢了就永远丢了
--       （`CommandResult` 是 Protected 会重放，回执不是）；
--    ③ 网关从不调用 `app.record_command_delivery_attempt`，所以命令即使被推送过
--       很多次，状态也一直是 'queued'，永远不会变成 'dispatched'。
--
--    于是「设备执行完就掉线」这条路上：短信已经交给模组，回执丢了，云端看到一条
--    从没被接受过的命令，写下「这条短信没有发出去，可以直接重发」—— 运维照做就是
--    再花一次钱。生产实测（2026-09-18）：12 条过期命令**全部**是这一支。
--
-- ⚠️ 名单从 `pg_proc` 枚举，不点名函数。那句话在三个函数里（expire_command /
--    expire_overdue_commands / expire_overdue_tenant_commands），而 0068 自己的
--    注释就写着「两处必须说同一句话」—— 点名的守卫会在加第四处时留在原地。

BEGIN;

-- ① 没有任何函数再断言短信没发出去。
DO $$
DECLARE
    offenders text;
BEGIN
    SELECT string_agg(proname, ', ' ORDER BY proname) INTO offenders
      FROM pg_proc
     WHERE pronamespace = 'app'::regnamespace
       -- 🔴 钉的是那句**会花钱的建议**，不是「没有发出去」这几个字 ——
       --    改好之后的说法里也有这几个字（「这不能证明短信没有发出去」），
       --    按字面查会把修好的版本一起判红。第一版就是这么红的。
       AND prosrc LIKE '%可以直接重发%';
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION '这些函数在叫运维直接重发，而云端并不知道短信发没发出去：%',
                        offenders;
    END IF;
END
$$;

-- ② 正面对照：那几句话本身还在。
--
-- 🔴 少了这一条，把整段 failure_reason 删掉也能让上面那条变绿 —— 而那样运维
--    看到的是一条没有任何解释的失败。
DO $$
DECLARE
    explained integer;
BEGIN
    SELECT count(*) INTO explained
      FROM pg_proc
     WHERE pronamespace = 'app'::regnamespace
       AND prosrc LIKE '%接收回执不重传%';
    IF explained < 3 THEN
        RAISE EXCEPTION '只有 % 个函数在过期时解释原因，期望至少 3 个'
                        '（expire_command / expire_overdue_commands / '
                        'expire_overdue_tenant_commands）', explained;
    END IF;
END
$$;

-- ③ 真的跑一遍：过期之后消息上写的是什么。
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('9c000000-0000-4000-8000-000000000001', 'expiry', 'expiry', 'active', 'cn');

SELECT set_config('app.tenant_id', '9c000000-0000-4000-8000-000000000001', true);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('9c000000-0000-4000-8000-000000000002',
        '9c000000-0000-4000-8000-000000000001', '860000000000077', 'expiry', 'iot');

CREATE TEMP TABLE sent_command AS
SELECT id FROM app.enqueue_command(
    '9c000000-0000-4000-8000-000000000001'::uuid,
    '9c000000-0000-4000-8000-000000000002'::uuid,
    'send_sms', '{"kind":"SendSms","to":"10086","body":"x"}'::jsonb,
    'expiry-wording', now() + interval '1 minute');

INSERT INTO app.messages
    (tenant_id, device_id, direction, peer, body, bearer, status, received_at, seq, command_id)
SELECT '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000002',
       'outbound', '10086', 'x', 'unknown', 'queued', now(), 0, id
  FROM sent_command;

SELECT app.expire_overdue_tenant_commands(
    '9c000000-0000-4000-8000-000000000001'::uuid, now() + interval '2 minutes');

DO $$
DECLARE
    said text;
BEGIN
    SELECT failure_reason INTO said
      FROM app.messages
     WHERE command_id = (SELECT id FROM sent_command);

    IF said IS NULL THEN
        RAISE EXCEPTION '过期之后消息上没有任何解释';
    END IF;
    IF said LIKE '%可以直接重发%' THEN
        RAISE EXCEPTION '过期结算仍然在叫运维直接重发：%', said;
    END IF;
    IF said NOT LIKE '%接收回执%' THEN
        RAISE EXCEPTION '过期结算没有说清楚云端到底知道什么：%', said;
    END IF;
END
$$;

ROLLBACK;
