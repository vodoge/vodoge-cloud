BEGIN;

-- The gateway protocol has a terminal `unknown` result for side effects whose
-- outcome cannot be safely retried after an edge crash. Keep that fact distinct
-- from a generic failure in the durable command state.
ALTER TYPE app.command_status ADD VALUE IF NOT EXISTS 'unknown';

-- command_receipts predates the current edge protocol. Preserve its immutable
-- receipt history while adding the two protocol-level receipt outcomes.
ALTER TYPE app.command_receipt_kind ADD VALUE IF NOT EXISTS 'duplicate';
ALTER TYPE app.command_receipt_kind ADD VALUE IF NOT EXISTS 'retry_later';

-- A resolved wakeup remains an audit record, but no claim or reconciliation
-- path may schedule it again. This is separate from the last publish state.
ALTER TABLE app.command_outbox
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- The CommandDeliver envelope ID is a physical-delivery identity, distinct
-- from the logical command ID. Recording it before the WebSocket write makes
-- a crash after the write observable and lets the receipt be authenticated
-- against a concrete attempt.
CREATE TABLE app.command_delivery_attempts (
    tenant_id uuid NOT NULL,
    command_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    attempt integer NOT NULL,
    dispatched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT command_delivery_attempts_pkey
        PRIMARY KEY (tenant_id, delivery_id),
    CONSTRAINT command_delivery_attempts_delivery_id_key
        UNIQUE (delivery_id),
    CONSTRAINT command_delivery_attempts_command_attempt_key
        UNIQUE (tenant_id, command_id, attempt),
    CONSTRAINT command_delivery_attempts_command_delivery_key
        UNIQUE (tenant_id, command_id, delivery_id),
    CONSTRAINT command_delivery_attempts_command_tenant_fkey
        FOREIGN KEY (tenant_id, command_id)
        REFERENCES app.commands (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT command_delivery_attempts_attempt_positive
        CHECK (attempt >= 1)
);

CREATE INDEX command_delivery_attempts_command_idx
    ON app.command_delivery_attempts (tenant_id, command_id, attempt DESC);

ALTER TABLE app.command_receipts
    ADD COLUMN IF NOT EXISTS delivery_id uuid,
    ADD COLUMN IF NOT EXISTS retry_at timestamptz,
    ADD COLUMN IF NOT EXISTS reason_code text;

ALTER TABLE app.command_receipts
    ADD CONSTRAINT command_receipts_delivery_attempt_fkey
        FOREIGN KEY (tenant_id, command_id, delivery_id)
        REFERENCES app.command_delivery_attempts (tenant_id, command_id, delivery_id);

ALTER TABLE app.command_receipts
    ADD CONSTRAINT command_receipts_retry_at_shape CHECK (
        (kind::text = 'retry_later' AND retry_at IS NOT NULL)
        OR (kind::text <> 'retry_later' AND retry_at IS NULL)
    );

ALTER TABLE app.command_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.command_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.command_delivery_attempts
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Existing function versions were intentionally minimal. Their lifecycle-aware
-- replacements exclude resolved outbox rows so accepted or terminal commands
-- cannot be woken again by a periodic reconciliation pass.
CREATE OR REPLACE FUNCTION app.claim_command_outbox(
    p_tenant_id uuid,
    p_worker text,
    p_limit integer DEFAULT 100,
    p_lease_for interval DEFAULT interval '30 seconds'
)
RETURNS TABLE (
    outbox_id bigint,
    command_id uuid,
    device_id uuid,
    kind app.command_kind,
    payload jsonb,
    attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match outbox claim tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'outbox worker must not be empty'
            USING ERRCODE = '22023';
    END IF;

    IF p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'outbox claim limit must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;

    IF p_lease_for <= interval '0 seconds' THEN
        RAISE EXCEPTION 'outbox lease must be positive'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT o.id
        FROM app.command_outbox AS o
        JOIN app.commands AS cmd
          ON cmd.tenant_id = o.tenant_id
         AND cmd.id = o.command_id
        WHERE o.tenant_id = p_tenant_id
          AND o.resolved_at IS NULL
          AND cmd.status IN ('queued', 'dispatched')
          AND (
              (o.status = 'pending' AND o.available_at <= now())
              OR (o.status = 'leased' AND o.lease_expires_at <= now())
          )
        ORDER BY o.id
        LIMIT p_limit
        FOR UPDATE OF o SKIP LOCKED
    ), claimed AS (
        UPDATE app.command_outbox AS o
        SET status = 'leased',
            lease_owner = p_worker,
            lease_expires_at = now() + p_lease_for,
            attempt_count = o.attempt_count + 1,
            last_error = NULL
        FROM candidates AS c
        WHERE o.id = c.id
        RETURNING o.id, o.command_id, o.attempt_count
    )
    SELECT c.id,
           c.command_id,
           cmd.device_id,
           cmd.kind,
           cmd.payload,
           c.attempt_count
    FROM claimed AS c
    JOIN app.commands AS cmd
      ON cmd.tenant_id = p_tenant_id
     AND cmd.id = c.command_id;
END
$$;

CREATE OR REPLACE FUNCTION app.mark_command_outbox_published(
    p_tenant_id uuid,
    p_outbox_id bigint,
    p_worker text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match outbox tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'outbox worker must not be empty'
            USING ERRCODE = '22023';
    END IF;

    UPDATE app.command_outbox
    SET status = 'published',
        lease_owner = NULL,
        lease_expires_at = NULL,
        published_at = now()
    WHERE tenant_id = p_tenant_id
      AND id = p_outbox_id
      AND resolved_at IS NULL
      AND status = 'leased'
      AND lease_owner = p_worker
      AND lease_expires_at > now();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

CREATE OR REPLACE FUNCTION app.requeue_unresolved_outbox(
    p_tenant_id uuid,
    p_after interval DEFAULT interval '30 seconds',
    p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_count integer;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match outbox tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_after < interval '0 seconds' THEN
        RAISE EXCEPTION 'outbox reconciliation delay cannot be negative'
            USING ERRCODE = '22023';
    END IF;

    IF p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'outbox reconciliation limit must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;

    WITH candidates AS (
        SELECT o.id
        FROM app.command_outbox AS o
        JOIN app.commands AS c
          ON c.tenant_id = o.tenant_id
         AND c.id = o.command_id
        WHERE o.tenant_id = p_tenant_id
          AND o.resolved_at IS NULL
          AND o.status = 'published'
          AND o.published_at <= now() - p_after
          AND c.status IN ('queued', 'dispatched')
        ORDER BY o.id
        LIMIT p_limit
        FOR UPDATE OF o SKIP LOCKED
    )
    UPDATE app.command_outbox AS o
    SET status = 'pending',
        available_at = now(),
        published_at = NULL
    FROM candidates AS c
    WHERE o.id = c.id;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;

-- A failed Redis or gateway wakeup is a scheduling event, never a command
-- failure. Only the worker that currently owns a live lease can retry it.
CREATE OR REPLACE FUNCTION app.retry_command_outbox_wakeup(
    p_tenant_id uuid,
    p_outbox_id bigint,
    p_worker text,
    p_available_at timestamptz,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match outbox retry tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'outbox worker must not be empty'
            USING ERRCODE = '22023';
    END IF;

    IF p_available_at IS NULL OR p_available_at <= now() THEN
        RAISE EXCEPTION 'outbox retry time must be in the future'
            USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 4096 THEN
        RAISE EXCEPTION 'outbox retry reason must contain at most 4096 characters'
            USING ERRCODE = '22023';
    END IF;

    UPDATE app.command_outbox
    SET status = 'pending',
        available_at = p_available_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        published_at = NULL,
        last_error = p_reason
    WHERE tenant_id = p_tenant_id
      AND id = p_outbox_id
      AND resolved_at IS NULL
      AND status = 'leased'
      AND lease_owner = p_worker
      AND lease_expires_at > now();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

-- Expiry is terminal only before a durable edge acceptance. Once accepted, the
-- edge owns execution and may report a later terminal result; the cloud must
-- not overwrite that fact with a local timeout.
CREATE OR REPLACE FUNCTION app.expire_command(
    p_tenant_id uuid,
    p_command_id uuid,
    p_expired_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
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

    RETURN true;
END
$$;

-- The persisted attempt is written before CommandDeliver leaves the gateway.
-- Replaying the exact same record is harmless; reusing its delivery ID or
-- attempt number for a different physical send is an integrity error.
CREATE OR REPLACE FUNCTION app.record_command_delivery_attempt(
    p_tenant_id uuid,
    p_command_id uuid,
    p_delivery_id uuid,
    p_attempt integer,
    p_dispatched_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_command app.commands%ROWTYPE;
    v_existing app.command_delivery_attempts%ROWTYPE;
    v_last_attempt integer;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command delivery tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_delivery_id IS NULL OR p_attempt IS NULL OR p_attempt < 1
        OR p_dispatched_at IS NULL THEN
        RAISE EXCEPTION 'delivery ID, positive attempt, and dispatch time are required'
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

    SELECT * INTO v_existing
    FROM app.command_delivery_attempts
    WHERE tenant_id = p_tenant_id
      AND delivery_id = p_delivery_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.command_id = p_command_id
            AND v_existing.attempt = p_attempt
            AND v_existing.dispatched_at = p_dispatched_at THEN
            RETURN false;
        END IF;

        RAISE EXCEPTION 'delivery ID is already bound to a different attempt'
            USING ERRCODE = '23505';
    END IF;

    IF v_command.status NOT IN ('queued', 'dispatched') THEN
        RETURN false;
    END IF;

    IF v_command.expires_at <= p_dispatched_at THEN
        RAISE EXCEPTION 'cannot record delivery for an expired command'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(max(attempt), 0) INTO v_last_attempt
    FROM app.command_delivery_attempts
    WHERE tenant_id = p_tenant_id
      AND command_id = p_command_id;

    IF p_attempt <> v_last_attempt + 1 THEN
        RAISE EXCEPTION 'delivery attempt must be the next persisted attempt'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.command_delivery_attempts (
        tenant_id,
        command_id,
        delivery_id,
        attempt,
        dispatched_at
    ) VALUES (
        p_tenant_id,
        p_command_id,
        p_delivery_id,
        p_attempt,
        p_dispatched_at
    );

    UPDATE app.commands
    SET status = 'dispatched',
        dispatched_at = COALESCE(dispatched_at, p_dispatched_at)
    WHERE tenant_id = p_tenant_id
      AND id = p_command_id;

    RETURN true;
END
$$;

-- Returns true only for a replay of the same receipt envelope. Accepted and
-- duplicate receipts stop future delivery; retry_later retains the command and
-- moves its wakeup to the bounded cloud-side retry time.
CREATE OR REPLACE FUNCTION app.apply_command_receipt(
    p_tenant_id uuid,
    p_receipt_id uuid,
    p_command_id uuid,
    p_delivery_id uuid,
    p_status text,
    p_received_at timestamptz,
    p_retry_at timestamptz DEFAULT NULL,
    p_reason_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_existing app.command_receipts%ROWTYPE;
    v_command app.commands%ROWTYPE;
    v_effective_retry_at timestamptz;
    v_reason_code text;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command receipt tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_receipt_id IS NULL OR p_command_id IS NULL OR p_delivery_id IS NULL
        OR p_received_at IS NULL THEN
        RAISE EXCEPTION 'receipt, command, delivery IDs and receipt time are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('accepted', 'duplicate', 'retry_later') THEN
        RAISE EXCEPTION 'unsupported command receipt status'
            USING ERRCODE = '22023';
    END IF;

    v_reason_code := NULLIF(p_reason_code, '');
    IF v_reason_code IS NOT NULL AND length(v_reason_code) > 128 THEN
        RAISE EXCEPTION 'receipt reason code must contain at most 128 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_status IN ('accepted', 'duplicate') AND p_retry_at IS NOT NULL THEN
        RAISE EXCEPTION 'accepted and duplicate receipts cannot set a retry time'
            USING ERRCODE = '22023';
    END IF;

    IF p_status = 'retry_later' THEN
        IF p_retry_at IS NULL OR p_retry_at <= now()
            OR p_retry_at > now() + interval '24 hours' THEN
            RAISE EXCEPTION 'retry_later receipt must set a retry time within 24 hours'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    SELECT * INTO v_existing
    FROM app.command_receipts
    WHERE id = p_receipt_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.command_id = p_command_id
            AND v_existing.delivery_id = p_delivery_id
            AND v_existing.kind::text = p_status
            AND v_existing.received_at = p_received_at
            AND v_existing.retry_at IS NOT DISTINCT FROM p_retry_at
            AND v_existing.reason_code IS NOT DISTINCT FROM v_reason_code THEN
            RETURN true;
        END IF;

        RAISE EXCEPTION 'receipt envelope ID is already bound to different evidence'
            USING ERRCODE = '23505';
    END IF;

    PERFORM 1
    FROM app.command_delivery_attempts
    WHERE tenant_id = p_tenant_id
      AND command_id = p_command_id
      AND delivery_id = p_delivery_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'receipt does not match a recorded command delivery'
            USING ERRCODE = 'P0002';
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

    IF p_status = 'retry_later' THEN
        v_effective_retry_at := LEAST(p_retry_at, v_command.expires_at);
    END IF;

    INSERT INTO app.command_receipts (
        id,
        tenant_id,
        command_id,
        kind,
        detail,
        received_at,
        delivery_id,
        retry_at,
        reason_code
    ) VALUES (
        p_receipt_id,
        p_tenant_id,
        p_command_id,
        p_status::app.command_receipt_kind,
        jsonb_strip_nulls(jsonb_build_object(
            'delivery_id', p_delivery_id,
            'status', p_status,
            'retry_at', p_retry_at,
            'reason_code', v_reason_code
        )),
        p_received_at,
        p_delivery_id,
        p_retry_at,
        v_reason_code
    );

    IF p_status IN ('accepted', 'duplicate') THEN
        IF v_command.status IN ('queued', 'dispatched') THEN
            UPDATE app.commands
            SET status = 'accepted',
                accepted_at = COALESCE(accepted_at, now())
            WHERE tenant_id = p_tenant_id
              AND id = p_command_id;
        END IF;

        UPDATE app.command_outbox
        SET resolved_at = COALESCE(resolved_at, now()),
            status = CASE WHEN status = 'leased' THEN 'published' ELSE status END,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE tenant_id = p_tenant_id
          AND command_id = p_command_id
          AND resolved_at IS NULL;
    ELSIF v_command.status IN ('queued', 'dispatched') THEN
        UPDATE app.command_outbox
        SET status = 'pending',
            available_at = v_effective_retry_at,
            lease_owner = NULL,
            lease_expires_at = NULL,
            published_at = NULL,
            last_error = CASE
                WHEN v_reason_code IS NULL THEN 'edge requested retry_later'
                ELSE 'edge requested retry_later: ' || v_reason_code
            END
        WHERE tenant_id = p_tenant_id
          AND command_id = p_command_id
          AND resolved_at IS NULL;
    END IF;

    RETURN false;
END
$$;

-- Returns true only when a terminal CommandResult exactly matches the result
-- already persisted for cmd_id. A different terminal value is an integrity
-- conflict rather than last-write-wins state.
CREATE OR REPLACE FUNCTION app.apply_command_result(
    p_tenant_id uuid,
    p_command_id uuid,
    p_status text,
    p_completed_at timestamptz,
    p_attempts integer,
    p_reason_code text DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_details jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_command app.commands%ROWTYPE;
    v_result jsonb;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command result tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_command_id IS NULL OR p_completed_at IS NULL
        OR p_attempts IS NULL OR p_attempts < 0 OR p_attempts > 1000000 THEN
        RAISE EXCEPTION 'command result ID, completion time, and attempts are invalid'
            USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('succeeded', 'failed', 'unknown', 'expired', 'cancelled') THEN
        RAISE EXCEPTION 'unsupported terminal command result status'
            USING ERRCODE = '22023';
    END IF;

    IF p_reason_code IS NOT NULL AND length(p_reason_code) > 128 THEN
        RAISE EXCEPTION 'result reason code must contain at most 128 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NOT NULL AND length(p_reason) > 4096 THEN
        RAISE EXCEPTION 'result reason must contain at most 4096 characters'
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

    PERFORM 1
    FROM app.command_delivery_attempts
    WHERE tenant_id = p_tenant_id
      AND command_id = p_command_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'result does not match a recorded command delivery'
            USING ERRCODE = 'P0002';
    END IF;

    v_result := jsonb_strip_nulls(jsonb_build_object(
        'status', p_status,
        'completed_at', p_completed_at,
        'attempts', p_attempts,
        'reason_code', NULLIF(p_reason_code, ''),
        'reason', NULLIF(p_reason, ''),
        'details', p_details
    ));

    IF v_command.status NOT IN ('queued', 'dispatched', 'accepted') THEN
        IF v_command.status::text = p_status
            AND v_command.completed_at = p_completed_at
            AND v_command.result IS NOT DISTINCT FROM v_result THEN
            UPDATE app.command_outbox
            SET resolved_at = COALESCE(resolved_at, now()),
                status = CASE WHEN status = 'leased' THEN 'published' ELSE status END,
                lease_owner = NULL,
                lease_expires_at = NULL
            WHERE tenant_id = p_tenant_id
              AND command_id = p_command_id
              AND resolved_at IS NULL;
            RETURN true;
        END IF;

        RAISE EXCEPTION 'terminal command result conflicts with persisted result'
            USING ERRCODE = '23505';
    END IF;

    UPDATE app.commands
    SET status = p_status::app.command_status,
        completed_at = p_completed_at,
        result = v_result
    WHERE tenant_id = p_tenant_id
      AND id = p_command_id;

    UPDATE app.command_outbox
    SET resolved_at = COALESCE(resolved_at, now()),
        status = CASE WHEN status = 'leased' THEN 'published' ELSE status END,
        lease_owner = NULL,
        lease_expires_at = NULL
    WHERE tenant_id = p_tenant_id
      AND command_id = p_command_id
      AND resolved_at IS NULL;

    RETURN false;
END
$$;

-- New tables and functions are not covered by the broad revocations in 0001.
-- The normal tenant application cannot bypass these transactional state
-- transitions through direct inserts or updates.
REVOKE ALL ON app.command_delivery_attempts FROM PUBLIC;
REVOKE ALL ON app.command_delivery_attempts FROM vodoge_app;
REVOKE INSERT, UPDATE, DELETE ON app.command_receipts FROM vodoge_app;

REVOKE ALL ON FUNCTION app.retry_command_outbox_wakeup(
    uuid, bigint, text, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.expire_command(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_command_delivery_attempt(
    uuid, uuid, uuid, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_command_receipt(
    uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_command_result(
    uuid, uuid, text, timestamptz, integer, text, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.retry_command_outbox_wakeup(
    uuid, bigint, text, timestamptz, text
) TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.expire_command(uuid, uuid, timestamptz)
    TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.record_command_delivery_attempt(
    uuid, uuid, uuid, integer, timestamptz
) TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.apply_command_receipt(
    uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text
) TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.apply_command_result(
    uuid, uuid, text, timestamptz, integer, text, text, jsonb
) TO vodoge_dispatcher;

COMMIT;
