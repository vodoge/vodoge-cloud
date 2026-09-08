\set ON_ERROR_STOP on

-- Run after tenant_isolation.sql in a disposable database, or update
-- the fixed IDs below if the fixture is reused.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';

-- ⚠️ 这两行原本不在：这个测试是写来**接在别的测试后面**跑的，靠前一个测试
--    留下的租户和设备行。十个测试共用一个库、而且每个都 COMMIT，所以它的
--    红绿取决于文件名顺序。现在每个测试各跑在自己的库上，前置行必须自己建。
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('11111111-1111-1111-1111-111111111111', 'command-outbox',
        'Command Outbox', 'active', 'cn');

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111',
        '860000000000011', 'command-outbox-device', 'sms');

DO $$
DECLARE
    v_first_id uuid;
    v_second_id uuid;
    v_commands integer;
BEGIN
    SELECT id INTO v_first_id
    FROM app.enqueue_command(
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'send_sms'::app.command_kind,
        '{"peer":"15550000000","body":"test"}'::jsonb,
        'test-command-1',
        now() + interval '5 minutes'
    );

    SELECT id INTO v_second_id
    FROM app.enqueue_command(
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'send_sms'::app.command_kind,
        '{"peer":"15550000000","body":"test"}'::jsonb,
        'test-command-1',
        now() + interval '5 minutes'
    );

    IF v_first_id <> v_second_id THEN
        RAISE EXCEPTION 'idempotent command enqueue returned different IDs';
    END IF;

    SELECT count(*) INTO v_commands
    FROM app.commands
    WHERE idempotency_key = 'test-command-1';

    IF v_commands <> 1 THEN
        RAISE EXCEPTION 'expected one command, got %', v_commands;
    END IF;
END
$$;
COMMIT;

RESET ROLE;

-- The normal application role intentionally cannot read app.command_outbox.
-- Verify the atomic outbox row from the administrative migration context.
BEGIN;

DO $$
DECLARE
    v_outbox integer;
BEGIN
    SELECT count(*) INTO v_outbox
    FROM app.command_outbox AS o
    JOIN app.commands AS c
      ON c.tenant_id = o.tenant_id
     AND c.id = o.command_id
    WHERE c.tenant_id = '11111111-1111-1111-1111-111111111111'
      AND c.idempotency_key = 'test-command-1';

    IF v_outbox <> 1 THEN
        RAISE EXCEPTION 'expected one outbox row, got %', v_outbox;
    END IF;
END
$$;

COMMIT;
