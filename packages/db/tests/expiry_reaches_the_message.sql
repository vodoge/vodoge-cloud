-- 命令过期之后，那条短信必须跟着落地。
--
-- 🔴 生产上一对一地坐实过（2026-09-11）：3 个 expired 的 send_sms 命令，
--    3 条停在 queued 的出站短信，`command_id` 一一对应，最早 2026-08-22。
--    有人 20 天前按下「发送」，控制台至今显示「排队中」—— 而它永远不会再动，
--    因为 `app.expire_overdue_commands` 从 0037 起就没有提到过 app.messages。
--
-- ⚠️ 「排队中」是这个故障最坏的地方：它读起来像「马上就发」，所以没有人会
--    去查。一个错的终态会被发现，一个永远的中间态不会。
\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '55555555-5555-5555-5555-555555555555';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('55555555-5555-5555-5555-555555555555', 'expiry', 'Expiry', 'active', 'cn');

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        '55555555-5555-5555-5555-555555555555',
        '860000000000055', 'expiry-device', 'sms');

DO $$
DECLARE
    v_never_accepted uuid;
    v_after_accept   uuid;
    v_succeeded      uuid;
    v_status         text;
    v_reason         text;
    v_expired        integer;
BEGIN
    -- ⚠️ 命令走 `app.enqueue_command` 造，不直接 INSERT —— `vodoge_app` 只有
    --    SELECT/UPDATE，没有 INSERT，而且走函数才是真实路径。
    --
    -- ⚠️ 到期时间必须在**未来**（`commands_expiry_after_issue` 要求
    --    expires_at > issued_at，造不出一条「生下来就过期」的命令）。所以
    --    过期是靠给 `expire_overdue_commands` 传一个更晚的 `p_now` 触发的 ——
    --    那个参数本来就是为这件事存在的。
    --
    -- ① 一条从来没被设备接过的命令。过期之后这条短信**肯定没发出去**。
    SELECT id INTO v_never_accepted FROM app.enqueue_command(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        'send_sms'::app.command_kind,
        '{"peer":"10086","body":"never"}'::jsonb,
        'k-never',
        now() + interval '5 minutes'
    );

    -- ② 一条设备**接过**的命令。过期之后它可能真的发出去了。
    SELECT id INTO v_after_accept FROM app.enqueue_command(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        'send_sms'::app.command_kind,
        '{"peer":"10086","body":"after"}'::jsonb,
        'k-after',
        now() + interval '5 minutes'
    );
    UPDATE app.commands
       SET status = 'accepted', accepted_at = now() - interval '25 minutes'
     WHERE id = v_after_accept;

    -- ③ 一条已经成功的命令。它不该被过期碰到，它的短信也不该被改。
    SELECT id INTO v_succeeded FROM app.enqueue_command(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        'send_sms'::app.command_kind,
        '{"peer":"10086","body":"done"}'::jsonb,
        'k-done',
        now() + interval '5 minutes'
    );
    UPDATE app.commands
       SET status = 'succeeded', completed_at = now() - interval '20 minutes'
     WHERE id = v_succeeded;

    INSERT INTO app.messages
        (tenant_id, device_id, direction, status, peer, body, bearer, encoding,
         received_at, seq, command_id)
    VALUES
        ('55555555-5555-5555-5555-555555555555', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
         'outbound', 'queued', '10086', 'never', 'unknown', 'gsm7', now(), 0, v_never_accepted),
        ('55555555-5555-5555-5555-555555555555', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
         'outbound', 'queued', '10086', 'after', 'unknown', 'gsm7', now(), 1, v_after_accept),
        -- ③ 的短信已经是 sent（命令成功了）。
        ('55555555-5555-5555-5555-555555555555', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
         'outbound', 'sent', '10086', 'done', 'unknown', 'gsm7', now(), 2, v_succeeded);

    SELECT app.expire_overdue_commands(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        now() + interval '10 minutes'
    ) INTO v_expired;

    IF v_expired <> 2 THEN
        RAISE EXCEPTION '过期了 % 条命令，预期 2 条（成功的那条不该被碰）', v_expired;
    END IF;

    -- 从没被接过的那条：落到 failed，而且那句话要说「可以直接重发」。
    SELECT status, failure_reason INTO v_status, v_reason
      FROM app.messages WHERE command_id = v_never_accepted;
    IF v_status IS DISTINCT FROM 'failed' THEN
        RAISE EXCEPTION
            '命令过期了，短信还停在 %（生产上这样停了 20 天，而「排队中」读起来像马上就发）',
            v_status;
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION '落到 failed 却没说为什么 —— 运维看到的会是一条没有理由的失败';
    END IF;
    IF v_reason NOT LIKE '%可以直接重发%' THEN
        RAISE EXCEPTION '没有告诉运维这条可以直接重发: %', v_reason;
    END IF;

    -- 🔴 设备接过的那条：话必须不一样。
    --
    -- 合成一句的代价是运维对一条**可能已经到达对方手机**的短信按了重发。
    -- 这个仓库已有同样的先例（modem_left_bus_after_submit 的文案）。
    SELECT status, failure_reason INTO v_status, v_reason
      FROM app.messages WHERE command_id = v_after_accept;
    IF v_status IS DISTINCT FROM 'failed' THEN
        RAISE EXCEPTION '接受过的那条没有落地: %', v_status;
    END IF;
    IF v_reason NOT LIKE '%先查投递回执%' THEN
        RAISE EXCEPTION
            '设备接受过这条命令，而那句话没有提醒先查投递回执 —— '
            '运维会对一条可能已经发出去的短信按重发: %', v_reason;
    END IF;

    -- 成功的那条一个字都不许动。
    SELECT status, failure_reason INTO v_status, v_reason
      FROM app.messages WHERE command_id = v_succeeded;
    IF v_status IS DISTINCT FROM 'sent' THEN
        RAISE EXCEPTION '一条命令已经成功的短信被过期改成了 %', v_status;
    END IF;
    IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION '给一条成功的短信写了失败原因: %', v_reason;
    END IF;
END
$$;
COMMIT;

-- ⑤ 过期只结算还在 `queued` 的那一种，不碰 `sent`。
--
-- ⚠️ 这个组合（命令 accepted、消息已经 sent）今天**构造不出来**：消息变成
--    sent 只发生在命令 succeeded 之后，而 succeeded 的命令进不了过期那个
--    WHERE。所以这里直接手工摆出这个状态 —— 钉的是**规则**，不是当前可达的
--    路径：哪天有别的写入者提前把消息写成 sent，过期不该顺手替它下结论。
--
-- 🔴 变异验证时发现：去掉那句 `AND m.status = 'queued'`，前面几条断言照样绿。
--    一条抓不住的防御是不是该留下，答案是留 —— 但得有一条断言说明它在防什么，
--    否则下一个人会把它当成多余的条件删掉。
BEGIN;
SET LOCAL app.tenant_id = '55555555-5555-5555-5555-555555555555';
DO $$
DECLARE
    v_command uuid;
    v_status  text;
    v_reason  text;
BEGIN
    SELECT id INTO v_command FROM app.enqueue_command(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        'send_sms'::app.command_kind,
        '{"peer":"10086","body":"handed"}'::jsonb,
        'k-handed',
        now() + interval '5 minutes'
    );
    -- 命令停在 accepted —— 它是会被过期收走的那一类。
    UPDATE app.commands
       SET status = 'accepted', accepted_at = now()
     WHERE id = v_command;

    INSERT INTO app.messages
        (tenant_id, device_id, direction, status, peer, body, bearer, encoding,
         received_at, seq, command_id)
    VALUES ('55555555-5555-5555-5555-555555555555', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
            'outbound', 'sent', '10086', 'handed', 'unknown', 'gsm7', now(), 4, v_command);

    PERFORM app.expire_overdue_commands(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        now() + interval '10 minutes'
    );

    SELECT status, failure_reason INTO v_status, v_reason
      FROM app.messages WHERE command_id = v_command;
    IF v_status IS DISTINCT FROM 'sent' THEN
        RAISE EXCEPTION
            '一条已经是 sent 的短信被过期改成了 % —— 它已经交给模组了，'
            '过期不该替它下结论', v_status;
    END IF;
    IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION '给一条已经 sent 的短信写了失败原因: %', v_reason;
    END IF;
END
$$;
COMMIT;

-- ④ 绝不覆盖一条更具体的原因。
--
-- 🔴 边缘写下来的原因（「QMI transport error: …」之类）比「云端等超时了」
--    有用得多。覆盖掉它，就是把这次故障真正的线索换成一句泛泛的话。
BEGIN;
SET LOCAL app.tenant_id = '55555555-5555-5555-5555-555555555555';
DO $$
DECLARE
    v_command uuid;
    v_reason  text;
BEGIN
    SELECT id INTO v_command FROM app.enqueue_command(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        'send_sms'::app.command_kind,
        '{"peer":"10086","body":"x"}'::jsonb,
        'k-specific',
        now() + interval '5 minutes'
    );

    INSERT INTO app.messages
        (tenant_id, device_id, direction, status, peer, body, bearer, encoding,
         received_at, seq, command_id, failure_reason)
    VALUES ('55555555-5555-5555-5555-555555555555', 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
            'outbound', 'queued', '10086', 'x', 'unknown', 'gsm7', now(), 3, v_command,
            'QMI transport error: cdc-wdm poll revents 0x18');

    PERFORM app.expire_overdue_commands(
        '55555555-5555-5555-5555-555555555555',
        'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
        now() + interval '10 minutes'
    );

    SELECT failure_reason INTO v_reason FROM app.messages WHERE command_id = v_command;
    IF v_reason IS DISTINCT FROM 'QMI transport error: cdc-wdm poll revents 0x18' THEN
        RAISE EXCEPTION
            '边缘写下的具体原因被一句泛泛的话覆盖了 —— 那是这次故障唯一的线索: %',
            v_reason;
    END IF;
END
$$;
COMMIT;

RESET ROLE;
