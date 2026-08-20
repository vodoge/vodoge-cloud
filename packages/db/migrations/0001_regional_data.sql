BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TYPE app.command_kind AS ENUM (
    'send_sms',
    'restart_modem',
    'switch_esim_profile',
    'update_card_policy',
    'update_capability_matrix',
    'self_update'
);

CREATE TYPE app.command_status AS ENUM (
    'queued',
    'dispatched',
    'accepted',
    'succeeded',
    'failed',
    'timed_out',
    'expired',
    'cancelled'
);

CREATE TYPE app.command_receipt_kind AS ENUM (
    'accepted',
    'started',
    'completed'
);

CREATE TYPE app.outbox_status AS ENUM (
    'pending',
    'leased',
    'published'
);

-- The application must set this with SET LOCAL inside every transaction. A
-- missing context returns NULL, so RLS denies access instead of falling back to
-- a default tenant.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE app.devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    imei text NOT NULL,
    name text NOT NULL,
    vertical text NOT NULL,
    last_seen_at timestamptz,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT devices_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT devices_tenant_imei_key UNIQUE (tenant_id, imei),
    CONSTRAINT devices_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

CREATE TABLE app.modems (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    family text NOT NULL,
    firmware text,
    iccid text,
    imsi text,
    capability jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT modems_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT modems_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT modems_capability_is_object CHECK (jsonb_typeof(capability) = 'object')
);

CREATE TABLE app.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    modem_id uuid,
    direction text NOT NULL,
    peer text NOT NULL,
    body text NOT NULL,
    bearer text NOT NULL,
    received_at timestamptz NOT NULL,
    seq bigint NOT NULL,
    dedupe_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_device_seq_key UNIQUE (device_id, seq),
    CONSTRAINT messages_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id),
    CONSTRAINT messages_modem_tenant_fkey
        FOREIGN KEY (tenant_id, modem_id)
        REFERENCES app.modems (tenant_id, id),
    CONSTRAINT messages_direction_valid CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT messages_bearer_valid CHECK (bearer IN ('cellular', 'ims', 'sgs')),
    CONSTRAINT messages_seq_nonnegative CHECK (seq >= 0)
);

CREATE TABLE app.commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    kind app.command_kind NOT NULL,
    payload jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status app.command_status NOT NULL DEFAULT 'queued',
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    dispatched_at timestamptz,
    accepted_at timestamptz,
    completed_at timestamptz,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT commands_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT commands_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT commands_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id),
    CONSTRAINT commands_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT commands_result_is_object CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    CONSTRAINT commands_expiry_after_issue CHECK (expires_at > issued_at)
);

-- A receipt is immutable evidence that the edge persisted or executed a command.
-- Replayed receipts are deduplicated by their envelope ID.
CREATE TABLE app.command_receipts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    command_id uuid NOT NULL,
    kind app.command_receipt_kind NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT command_receipts_command_tenant_fkey
        FOREIGN KEY (tenant_id, command_id)
        REFERENCES app.commands (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT command_receipts_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

-- This is a durable wakeup record, not the command queue. The command remains
-- authoritative in app.commands until a persisted edge receipt or result updates it.
CREATE TABLE app.command_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    command_id uuid NOT NULL,
    status app.outbox_status NOT NULL DEFAULT 'pending',
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_expires_at timestamptz,
    published_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT command_outbox_command_tenant_fkey
        FOREIGN KEY (tenant_id, command_id)
        REFERENCES app.commands (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT command_outbox_command_key UNIQUE (command_id),
    CONSTRAINT command_outbox_attempt_nonnegative CHECK (attempt_count >= 0),
    CONSTRAINT command_outbox_lease_shape CHECK (
        (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX messages_tenant_received_at_idx
    ON app.messages (tenant_id, received_at DESC);
CREATE INDEX messages_tenant_peer_idx
    ON app.messages (tenant_id, peer);
CREATE INDEX modems_device_idx
    ON app.modems (tenant_id, device_id);
CREATE INDEX commands_pending_device_idx
    ON app.commands (tenant_id, device_id, issued_at)
    WHERE status IN ('queued', 'dispatched');
CREATE INDEX command_outbox_pending_idx
    ON app.command_outbox (available_at, id)
    WHERE status = 'pending';

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END
$$;

CREATE TRIGGER devices_touch_updated_at
BEFORE UPDATE ON app.devices
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER modems_touch_updated_at
BEFORE UPDATE ON app.modems
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER commands_touch_updated_at
BEFORE UPDATE ON app.commands
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER command_outbox_touch_updated_at
BEFORE UPDATE ON app.command_outbox
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Command creation and its durable wakeup must share one database transaction.
-- A duplicate idempotency key returns the original command only if it describes
-- the same requested operation; otherwise the caller has reused a key incorrectly.
CREATE OR REPLACE FUNCTION app.enqueue_command(
    p_tenant_id uuid,
    p_device_id uuid,
    p_kind app.command_kind,
    p_payload jsonb,
    p_idempotency_key text,
    p_expires_at timestamptz
)
RETURNS app.commands
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_command app.commands%ROWTYPE;
    v_inserted boolean := false;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match requested command tenant'
            USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'command payload must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.commands (
        tenant_id,
        device_id,
        kind,
        payload,
        idempotency_key,
        expires_at
    ) VALUES (
        p_tenant_id,
        p_device_id,
        p_kind,
        p_payload,
        p_idempotency_key,
        p_expires_at
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING * INTO v_command;

    v_inserted := FOUND;

    IF NOT v_inserted THEN
        SELECT * INTO v_command
        FROM app.commands
        WHERE tenant_id = p_tenant_id
          AND idempotency_key = p_idempotency_key;

        IF v_command.device_id <> p_device_id
            OR v_command.kind <> p_kind
            OR v_command.payload <> p_payload THEN
            RAISE EXCEPTION 'idempotency key is already bound to a different command'
                USING ERRCODE = '23505';
        END IF;

        RETURN v_command;
    END IF;

    INSERT INTO app.command_outbox (tenant_id, command_id)
    VALUES (v_command.tenant_id, v_command.id);

    RETURN v_command;
END
$$;

-- Claiming is tenant-scoped on purpose. A dispatcher must establish the tenant
-- context for each claim; there is no cross-tenant table scan hidden behind a
-- broad BYPASSRLS role. Expired leases become eligible again, so a crashed
-- dispatcher cannot strand a wakeup forever.
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
        WHERE o.tenant_id = p_tenant_id
          AND (
              (o.status = 'pending' AND o.available_at <= now())
              OR (o.status = 'leased' AND o.lease_expires_at <= now())
          )
        ORDER BY o.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
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
     AND cmd.id = c.command_id
    WHERE cmd.status IN ('queued', 'dispatched');
END
$$;

-- Publishing a wakeup is not completion. The row remains as an audit trail and
-- can be re-leased if the worker crashes before the gateway observes it.
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

    UPDATE app.command_outbox
    SET status = 'published',
        lease_owner = NULL,
        lease_expires_at = NULL,
        published_at = now()
    WHERE tenant_id = p_tenant_id
      AND id = p_outbox_id
      AND status = 'leased'
      AND lease_owner = p_worker;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

-- A periodic reconciliation can make a published wakeup eligible again while
-- its command is still unresolved. This handles a Redis publish succeeding just
-- before a gateway crash without relying on Redis message retention.
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

    WITH candidates AS (
        SELECT o.id
        FROM app.command_outbox AS o
        JOIN app.commands AS c
          ON c.tenant_id = o.tenant_id
         AND c.id = o.command_id
        WHERE o.tenant_id = p_tenant_id
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

-- Tenant isolation is enforced in the database for every regional business table.
-- FORCE ROW LEVEL SECURITY keeps table owners inside the policy as well.
ALTER TABLE app.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.devices FORCE ROW LEVEL SECURITY;
ALTER TABLE app.modems ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.modems FORCE ROW LEVEL SECURITY;
ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE app.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commands FORCE ROW LEVEL SECURITY;
ALTER TABLE app.command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.command_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.command_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.devices
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.modems
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.messages
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.commands
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.command_receipts
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.command_outbox
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO vodoge_app;
GRANT USAGE ON SCHEMA app TO vodoge_dispatcher;
GRANT SELECT, INSERT, UPDATE ON app.devices, app.modems, app.messages,
    app.command_receipts TO vodoge_app;
GRANT SELECT ON app.commands TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.enqueue_command(
    uuid, uuid, app.command_kind, jsonb, text, timestamptz
) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.claim_command_outbox(
    uuid, text, integer, interval
) TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.mark_command_outbox_published(
    uuid, bigint, text
) TO vodoge_dispatcher;
GRANT EXECUTE ON FUNCTION app.requeue_unresolved_outbox(
    uuid, interval, integer
) TO vodoge_dispatcher;

COMMIT;
