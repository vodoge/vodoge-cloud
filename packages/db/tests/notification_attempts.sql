-- 通知投递要留痕，而且按租户隔离。
--
-- 🔴 这张表存在的理由：在它之前通知**一点痕迹都不留**。命令有
--    app.command_delivery_attempts（0002 起），通知只有一个内存计数器，
--    随网关重启清零 —— 而生产上没有任何东西在抓 /metrics。
--    2026-09-11 我两次在交付说明里写「投递那一段没法在生产上验证」，
--    就是因为没有任何持久记录能回答「发出去过没有」。
\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '44444444-4444-4444-4444-444444444444';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('44444444-4444-4444-4444-444444444444', 'notify-log', 'Notify Log', 'active', 'cn');

DO $$
DECLARE
    v_detail text;
    v_rows   integer;
BEGIN
    INSERT INTO app.notification_attempts (tenant_id, kind, channel, result, detail)
    VALUES ('44444444-4444-4444-4444-444444444444', 'edge.alert', 'telegram', 'delivered', NULL),
           ('44444444-4444-4444-4444-444444444444', 'edge.alert', 'webhook', 'failed',
            'Post "http://hooktest:19999/hook": dial tcp: lookup hooktest: no such host');

    -- ① 失败那句话原样留着。
    --
    -- ⚠️ 归类成枚举等于把下一次的诊断线索提前扔掉 —— 这个仓库上一次靠一句
    --    原文定位到问题是 0065（投递回执被静默删掉那次）。
    SELECT detail INTO v_detail FROM app.notification_attempts WHERE result = 'failed';
    IF v_detail NOT LIKE '%no such host%' THEN
        RAISE EXCEPTION '通道自己那句话没有原样留下: %', v_detail;
    END IF;

    -- ② 只有两种结果。'dropped'、'pending' 这类含糊的值进不来：
    --    这张表回答的是「发没发出去」。
    BEGIN
        INSERT INTO app.notification_attempts (tenant_id, kind, channel, result)
        VALUES ('44444444-4444-4444-4444-444444444444', 'x', 'y', 'maybe');
        RAISE EXCEPTION '写进了一个不是 delivered/failed 的结果';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    SELECT count(*) INTO v_rows FROM app.notification_attempts;
    IF v_rows <> 2 THEN
        RAISE EXCEPTION '本租户应当看到 2 行，实际 %', v_rows;
    END IF;
END
$$;
COMMIT;

-- ③ 租户隔离：另一个租户看不见上面那两行。
--
-- 🔴 通知里带着设备 id 和故障原文。这张表虽然不存正文，但「哪个租户在什么
--    时候发了什么种类的通知」本身就是运营信息。
BEGIN;
SET LOCAL app.tenant_id = '33333333-3333-3333-3333-333333333333';
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('33333333-3333-3333-3333-333333333333', 'other', 'Other', 'active', 'cn');
DO $$
DECLARE
    v_rows integer;
BEGIN
    SELECT count(*) INTO v_rows FROM app.notification_attempts;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION '另一个租户看见了 % 行别人的通知记录', v_rows;
    END IF;
END
$$;
COMMIT;

-- ④ 属主必须是 vodoge_owner。
--
-- 🔴 这一条是 0066 那次用 2 分 40 秒全线上行失败换来的教训的延伸：schema 里
--    其余的表都归 vodoge_owner，留一张不一致的就是给下一个人留陷阱。
--    夹具改不了属主，所以这条盖不住。
DO $$
DECLARE
    v_owner text;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
      FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relname = 'notification_attempts';
    IF v_owner IS DISTINCT FROM 'vodoge_owner' THEN
        RAISE EXCEPTION 'app.notification_attempts 归 %，而 schema 里其余的表归 vodoge_owner', v_owner;
    END IF;
END
$$;

RESET ROLE;
