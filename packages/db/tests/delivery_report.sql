-- 网络回来的投递回执，必须能落到那条已经发出去的消息上。
--
-- 🔴 这个测试存在的理由是一次静默回退。0036 给 app.accept_ingress 加了
--    'SmsStatusReport' 的 kind 白名单项和对应的投影分支。0044 的头注释写着
--    「Derived from 0035's text so everything outside the changed projection
--    block is character-identical」——而 0035 在 0036 **之前**。那次
--    CREATE OR REPLACE 把白名单和整个分支一起抹掉了，之后 0047 / 0060 /
--    0062 / 0063 / 0064 全部继承了这份缺失的函数体。
--
--    后果不是少一个字段：边缘每 8 秒仍在读 SR 存储、解码、删除、上行，
--    网关也把它算作合法 kind，只有数据库拒收——于是每一条回执被写成
--    Unstorable 墓碑、ack 掉、**永久丢失**（墓碑只留 reason/original_kind，
--    不留 payload）。生产上从 2026-08-28 到 2026-09-07 丢了 18 条，
--    app.messages.delivered_at 在这段时间里没有任何写入者。
--
--    而 modem_left_bus_after_submit 这个「失败但对端可能真收到了」的分支，
--    它的文案正是让运维「重发之前先查投递回执」。
--
-- ⚠️ 它能躺 11 天，是因为 packages/db/tests 下的测试**从来没有人跑过**：
--    CI 里没有任何一步执行它们。这个文件和把它们接进 CI 的那一步是一起加的。
\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '77777777-7777-7777-7777-777777777777';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '77777777-7777-7777-7777-777777777777',
    'delivery-report',
    'Delivery Report',
    'active',
    'cn'
);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '77777777-7777-7777-7777-777777777777',
    '860000000000007',
    'delivery-report-device',
    'sms'
);

-- 一条已经交给模组、拿到了 TP-MR 的外发消息。provider_reference 就是回执
-- 唯一能用来认领它的那个号。
INSERT INTO app.messages
    (tenant_id, device_id, direction, status, peer, body, bearer, encoding,
     received_at, seq, provider_reference)
VALUES
    ('77777777-7777-7777-7777-777777777777',
     'cccccccc-cccc-cccc-cccc-cccccccccccc',
     'outbound', 'sent', '10086', 'ping', 'unknown', 'gsm7',
     now(), 0, 42);

DO $$
DECLARE
    v_status text;
    v_msg_status text;
    v_delivered timestamptz;
    v_code integer;
BEGIN
    -- ① 'pending' 表示服务中心还在尝试。两种结局都还没发生，写下任何一个
    --    都等于给一条还在途中的消息盖棺。**必须先测它** —— 放在 delivered
    --    之后测，「把 pending 当成 delivered」这个改动是看不出来的。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '77777777-7777-7777-7777-777777777777',
          'cccccccc-cccc-cccc-cccc-cccccccccccc',
          1,
          '11111111-2222-3333-4444-555555555555',
          'SmsStatusReport',
          jsonb_build_object(
              'modem_imei', '860000000000007', 'peer', '10086',
              'reference', 42, 'status', 'pending',
              'status_code', 32, 'reported_at', 1788000000000::bigint
          )
      ) AS a;

    IF v_status <> 'inserted' THEN
        RAISE EXCEPTION 'delivery report was not accepted: status=%', v_status;
    END IF;

    SELECT m.status, m.delivered_at INTO v_msg_status, v_delivered
      FROM app.messages AS m
     WHERE m.provider_reference = 42 AND m.direction = 'outbound';

    IF v_msg_status <> 'sent' THEN
        RAISE EXCEPTION 'a pending report closed a message still in flight: %', v_msg_status;
    END IF;
    IF v_delivered IS NOT NULL THEN
        RAISE EXCEPTION 'a pending report wrote delivered_at: %', v_delivered;
    END IF;

    -- ② 真正的 delivered 回执：三样都要写上。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '77777777-7777-7777-7777-777777777777',
          'cccccccc-cccc-cccc-cccc-cccccccccccc',
          2,
          '11111111-2222-3333-4444-666666666666',
          'SmsStatusReport',
          jsonb_build_object(
              'modem_imei', '860000000000007', 'peer', '10086',
              'reference', 42, 'status', 'delivered',
              'status_code', 0, 'reported_at', 1788000001000::bigint
          )
      ) AS a;

    SELECT m.status, m.delivered_at, m.delivery_code
      INTO v_msg_status, v_delivered, v_code
      FROM app.messages AS m
     WHERE m.provider_reference = 42 AND m.direction = 'outbound';

    IF v_msg_status <> 'delivered' THEN
        RAISE EXCEPTION 'status not moved to delivered: %', v_msg_status;
    END IF;
    IF v_delivered IS NULL THEN
        RAISE EXCEPTION 'delivered_at was not written';
    END IF;
    -- TP-ST 原样保留。四态的 status 丢掉了原因，而原因才是「值不值得重发」
    -- 的依据 —— 所以 0 是一个必须被记下来的值，不能和 NULL 混为一谈。
    IF v_code IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'delivery_code not recorded verbatim: %', v_code;
    END IF;
END
$$;
COMMIT;

-- ③ ProxyTraffic 是同一处回退的另一半：函数体里有 ELSIF 分支，白名单里没有。
--    生产上一条都没有，只因为代理还没被用过——用起来的那天，每一封都会
--    走同样的墓碑路。这里只断言它**能被接受**，不断言投影内容。
BEGIN;
SET LOCAL app.tenant_id = '77777777-7777-7777-7777-777777777777';
DO $$
DECLARE
    v_status text;
BEGIN
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '77777777-7777-7777-7777-777777777777',
          'cccccccc-cccc-cccc-cccc-cccccccccccc',
          3,
          '11111111-2222-3333-4444-777777777777',
          'ProxyTraffic',
          '{"samples": []}'::jsonb
      ) AS a;

    IF v_status <> 'inserted' THEN
        RAISE EXCEPTION 'proxy traffic was not accepted: status=%', v_status;
    END IF;
END
$$;
COMMIT;

RESET ROLE;
