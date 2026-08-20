\set ON_ERROR_STOP on

-- This test owns its fixture and can run after the regional migrations without
-- relying on another test's data. The two runtime roles are exercised directly;
-- superusers and table owners would hide privilege or RLS mistakes.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '33333333-3333-3333-3333-333333333333';

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '33333333-3333-3333-3333-333333333333',
    '860000000000003',
    'dispatch-lifecycle-device',
    'cn'
);

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000001","body":"wakeup"}'::jsonb,
    'lifecycle-wakeup',
    now() + interval '20 minutes'
)).id AS lifecycle_wakeup_command
\gset

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000002","body":"accepted"}'::jsonb,
    'lifecycle-accepted',
    now() + interval '20 minutes'
)).id AS lifecycle_accepted_command
\gset

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000003","body":"duplicate"}'::jsonb,
    'lifecycle-duplicate',
    now() + interval '20 minutes'
)).id AS lifecycle_duplicate_command
\gset

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000004","body":"retry"}'::jsonb,
    'lifecycle-retry',
    now() + interval '20 minutes'
)).id AS lifecycle_retry_command
\gset

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000005","body":"result"}'::jsonb,
    'lifecycle-result',
    now() + interval '20 minutes'
)).id AS lifecycle_result_command
\gset

SELECT (app.enqueue_command(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'send_sms'::app.command_kind,
    '{"peer":"15550000006","body":"expiry"}'::jsonb,
    'lifecycle-expiry',
    now() + interval '1 minute'
)).id AS lifecycle_expiry_command
\gset

COMMIT;

-- The normal application role must not bypass the dispatcher-owned state
-- transitions with direct audit or receipt inserts.
BEGIN;
SET LOCAL app.tenant_id = '33333333-3333-3333-3333-333333333333';

DO $$
BEGIN
    BEGIN
        INSERT INTO app.command_delivery_attempts (
            tenant_id, command_id, delivery_id, attempt, dispatched_at
        ) VALUES (
            '33333333-3333-3333-3333-333333333333',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '10000000-0000-0000-0000-000000000001',
            1,
            now()
        );
        RAISE EXCEPTION 'vodoge_app unexpectedly inserted a delivery attempt';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        INSERT INTO app.command_receipts (
            id, tenant_id, command_id, kind, delivery_id
        ) VALUES (
            '20000000-0000-0000-0000-000000000001',
            '33333333-3333-3333-3333-333333333333',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'accepted',
            '10000000-0000-0000-0000-000000000001'
        );
        RAISE EXCEPTION 'vodoge_app unexpectedly inserted a command receipt';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$$;
COMMIT;

RESET ROLE;

SET ROLE vodoge_dispatcher;

BEGIN;
SET LOCAL app.tenant_id = '33333333-3333-3333-3333-333333333333';

-- Claim all fixture wakeups under a live dispatcher lease, then reschedule one
-- failed publication. This intentionally does not alter the logical command.
SELECT outbox_id AS lifecycle_wakeup_outbox
FROM app.claim_command_outbox(
    '33333333-3333-3333-3333-333333333333',
    'dispatcher-a',
    100,
    interval '10 minutes'
)
WHERE command_id = :'lifecycle_wakeup_command'::uuid
\gset

SELECT app.retry_command_outbox_wakeup(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_wakeup_outbox'::bigint,
    'dispatcher-a',
    clock_timestamp() + interval '5 minutes',
    'broker unavailable'
) AS lifecycle_wakeup_retried;

-- Persist four physical deliveries. The state is written before a gateway
-- frame would be sent, so all later receipt and result paths can authenticate
-- against a delivery_id.
SELECT app.record_command_delivery_attempt(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_accepted_command'::uuid,
    '10000000-0000-0000-0000-000000000010',
    1,
    clock_timestamp()
) AS lifecycle_accepted_delivery_recorded;

SELECT app.record_command_delivery_attempt(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_duplicate_command'::uuid,
    '10000000-0000-0000-0000-000000000011',
    1,
    clock_timestamp()
) AS lifecycle_duplicate_delivery_recorded;

SELECT app.record_command_delivery_attempt(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_retry_command'::uuid,
    '10000000-0000-0000-0000-000000000012',
    1,
    clock_timestamp()
) AS lifecycle_retry_delivery_recorded;

SELECT app.record_command_delivery_attempt(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_result_command'::uuid,
    '10000000-0000-0000-0000-000000000013',
    1,
    clock_timestamp()
) AS lifecycle_result_delivery_recorded;

SELECT clock_timestamp() AS lifecycle_receipt_at
\gset

SELECT app.apply_command_receipt(
    '33333333-3333-3333-3333-333333333333',
    '20000000-0000-0000-0000-000000000010',
    :'lifecycle_accepted_command'::uuid,
    '10000000-0000-0000-0000-000000000010',
    'accepted',
    :'lifecycle_receipt_at'::timestamptz
) AS lifecycle_accepted_receipt_duplicate;

-- Replaying an identical receipt envelope is a no-op and returns true.
SELECT app.apply_command_receipt(
    '33333333-3333-3333-3333-333333333333',
    '20000000-0000-0000-0000-000000000010',
    :'lifecycle_accepted_command'::uuid,
    '10000000-0000-0000-0000-000000000010',
    'accepted',
    :'lifecycle_receipt_at'::timestamptz
) AS lifecycle_accepted_receipt_replay;

SELECT app.apply_command_receipt(
    '33333333-3333-3333-3333-333333333333',
    '20000000-0000-0000-0000-000000000011',
    :'lifecycle_duplicate_command'::uuid,
    '10000000-0000-0000-0000-000000000011',
    'duplicate',
    clock_timestamp()
) AS lifecycle_duplicate_receipt_duplicate;

SELECT app.apply_command_receipt(
    '33333333-3333-3333-3333-333333333333',
    '20000000-0000-0000-0000-000000000012',
    :'lifecycle_retry_command'::uuid,
    '10000000-0000-0000-0000-000000000012',
    'retry_later',
    clock_timestamp(),
    clock_timestamp() + interval '2 minutes',
    'sqlite_busy'
) AS lifecycle_retry_receipt_duplicate;

SELECT clock_timestamp() AS lifecycle_result_at
\gset

SELECT app.apply_command_result(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_result_command'::uuid,
    'unknown',
    :'lifecycle_result_at'::timestamptz,
    1,
    'outcome_unknown',
    'modem restarted during side effect',
    '{"modem":"restarting"}'::jsonb
) AS lifecycle_result_duplicate;

-- Exact terminal-result replay is also a no-op and returns true.
SELECT app.apply_command_result(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_result_command'::uuid,
    'unknown',
    :'lifecycle_result_at'::timestamptz,
    1,
    'outcome_unknown',
    'modem restarted during side effect',
    '{"modem":"restarting"}'::jsonb
) AS lifecycle_result_replay;

-- The expiry procedure closes only a command that has not been accepted.
SELECT app.expire_command(
    '33333333-3333-3333-3333-333333333333',
    :'lifecycle_expiry_command'::uuid,
    clock_timestamp() + interval '2 hours'
) AS lifecycle_expired;

COMMIT;

-- Pass values through session settings so nested exception blocks can validate
-- conflict behavior while still executing as the non-superuser dispatcher.
BEGIN;
SET LOCAL app.tenant_id = '33333333-3333-3333-3333-333333333333';
SET LOCAL app.test_accepted_command_id = :'lifecycle_accepted_command';
SET LOCAL app.test_result_command_id = :'lifecycle_result_command';
SET LOCAL app.test_receipt_at = :'lifecycle_receipt_at';
SET LOCAL app.test_result_at = :'lifecycle_result_at';

DO $$
BEGIN
    BEGIN
        PERFORM app.apply_command_receipt(
            '33333333-3333-3333-3333-333333333333',
            '20000000-0000-0000-0000-000000000010',
            current_setting('app.test_accepted_command_id')::uuid,
            '10000000-0000-0000-0000-000000000010',
            'duplicate',
            current_setting('app.test_receipt_at')::timestamptz
        );
        RAISE EXCEPTION 'conflicting receipt replay was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        PERFORM app.apply_command_result(
            '33333333-3333-3333-3333-333333333333',
            current_setting('app.test_result_command_id')::uuid,
            'succeeded',
            current_setting('app.test_result_at')::timestamptz,
            1,
            'unexpected_success',
            NULL,
            '{"modem":"restarting"}'::jsonb
        );
        RAISE EXCEPTION 'conflicting terminal result was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$$;
COMMIT;

-- Tenant context is mandatory even for a SECURITY DEFINER function. A caller
-- cannot name another tenant's command while its request context is tenant B.
BEGIN;
SET LOCAL app.tenant_id = '44444444-4444-4444-4444-444444444444';
SET LOCAL app.test_foreign_command_id = :'lifecycle_expiry_command';

DO $$
BEGIN
    BEGIN
        PERFORM app.expire_command(
            '33333333-3333-3333-3333-333333333333',
            current_setting('app.test_foreign_command_id')::uuid,
            now() + interval '3 hours'
        );
        RAISE EXCEPTION 'dispatcher crossed a tenant boundary';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$$;
COMMIT;

RESET ROLE;

-- Inspect the durable state as the migration administrator. Every outbox row
-- is retained, but terminal/accepted ones are marked resolved and will never
-- be re-claimed by the dispatcher.
DO $$
DECLARE
    v_status text;
    v_outbox_status text;
    v_resolved_at timestamptz;
    v_available_at timestamptz;
    v_last_error text;
    v_result jsonb;
    v_attempts integer;
    v_receipts integer;
BEGIN
    SELECT c.status::text,
           o.status::text,
           o.resolved_at,
           o.available_at,
           o.last_error
    INTO v_status, v_outbox_status, v_resolved_at, v_available_at, v_last_error
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-wakeup';

    IF v_status <> 'queued'
        OR v_outbox_status <> 'pending'
        OR v_resolved_at IS NOT NULL
        OR v_available_at <= now()
        OR v_last_error <> 'broker unavailable' THEN
        RAISE EXCEPTION 'failed wakeup was not durably rescheduled';
    END IF;

    SELECT c.status::text,
           o.resolved_at,
           count(a.delivery_id),
           count(r.id)
    INTO v_status, v_resolved_at, v_attempts, v_receipts
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    LEFT JOIN app.command_delivery_attempts AS a
      ON a.tenant_id = c.tenant_id
     AND a.command_id = c.id
    LEFT JOIN app.command_receipts AS r
      ON r.tenant_id = c.tenant_id
     AND r.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-accepted'
    GROUP BY c.status, o.resolved_at;

    IF v_status <> 'accepted' OR v_resolved_at IS NULL
        OR v_attempts <> 1 OR v_receipts <> 1 THEN
        RAISE EXCEPTION 'accepted receipt did not stop delivery idempotently';
    END IF;

    SELECT c.status::text, o.resolved_at
    INTO v_status, v_resolved_at
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-duplicate';

    IF v_status <> 'accepted' OR v_resolved_at IS NULL THEN
        RAISE EXCEPTION 'duplicate receipt did not stop delivery';
    END IF;

    SELECT c.status::text,
           o.status::text,
           o.resolved_at,
           o.available_at,
           o.last_error
    INTO v_status, v_outbox_status, v_resolved_at, v_available_at, v_last_error
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-retry';

    IF v_status <> 'dispatched'
        OR v_outbox_status <> 'pending'
        OR v_resolved_at IS NOT NULL
        OR v_available_at <= now()
        OR v_last_error <> 'edge requested retry_later: sqlite_busy' THEN
        RAISE EXCEPTION 'retry_later receipt was not durably scheduled';
    END IF;

    SELECT c.status::text, o.resolved_at, c.result
    INTO v_status, v_resolved_at, v_result
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-result';

    IF v_status <> 'unknown' OR v_resolved_at IS NULL
        OR v_result ->> 'status' <> 'unknown' THEN
        RAISE EXCEPTION 'terminal result was not persisted exactly once';
    END IF;

    SELECT c.status::text, o.resolved_at
    INTO v_status, v_resolved_at
    FROM app.commands AS c
    JOIN app.command_outbox AS o
      ON o.tenant_id = c.tenant_id
     AND o.command_id = c.id
    WHERE c.tenant_id = '33333333-3333-3333-3333-333333333333'
      AND c.idempotency_key = 'lifecycle-expiry';

    IF v_status <> 'expired' OR v_resolved_at IS NULL THEN
        RAISE EXCEPTION 'expired command remained eligible for wakeups';
    END IF;
END
$$;
