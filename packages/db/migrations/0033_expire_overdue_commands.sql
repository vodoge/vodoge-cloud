-- Retire commands that outlived their expiry.
--
-- Seventeen commands issued between 06:09 and 09:01, while the uplink was
-- broken, are still sitting at status 'queued' with their outbox rows still
-- 'pending'. Every one of them expired hours ago. The console reads that status
-- and reports them as waiting for the device, which is not true and cannot
-- become true: the pickup query in PendingForDevice filters on
-- `expires_at > now`, so they were already unreachable the moment they lapsed.
--
-- app.expire_command has existed since 0002 and does exactly the right thing.
-- It is reached from dispatch.Dispatcher, and nothing calls Dispatcher: both
-- PollOutbox and DispatchPendingForDevice are unreferenced. The live delivery
-- path is wss/serve.go calling commands.SQLPending.PendingForDevice, which
-- filters expired commands out and leaves them where they are. So the function
-- that fixes this has been correct and unreachable the whole time.
--
-- This is the per-device form, called from that live path. Device resume is the
-- right trigger: commands belong to a device, the caller already holds the
-- tenant context these tables require, and the work is indexed and small.
--
-- A global sweep would be the more thorough answer and is not available.
-- app.tenants carries FORCE row-level security under
-- `id = app.current_tenant_id()`, so nothing -- including a SECURITY DEFINER
-- function owned by the table owner -- can enumerate tenants to sweep them.
-- The honest consequence: a device that never reconnects keeps its stale rows
-- until it does. That is a narrower wrong than reporting expired commands as
-- pending forever, and it converges the moment the device is seen again.

BEGIN;

CREATE OR REPLACE FUNCTION app.expire_overdue_commands(
    p_tenant_id uuid,
    p_device_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_expired integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match command expiry tenant'
            USING ERRCODE = '42501';
    END IF;

    WITH overdue AS (
        UPDATE app.commands
        SET status = 'expired',
            completed_at = p_now,
            updated_at = now(),
            -- The same shape app.expire_command writes, so a command that
            -- lapsed here is indistinguishable from one the dispatcher
            -- retired. Two spellings of "expired" would be a reporting bug
            -- waiting to happen.
            result = jsonb_build_object(
                'status', 'expired',
                'completed_at', p_now,
                'attempts', 0,
                'reason_code', 'cloud_expired'
            )
        WHERE tenant_id = p_tenant_id
          AND device_id = p_device_id
          AND status IN ('queued', 'dispatched')
          AND expires_at <= p_now
        RETURNING id
    ),
    -- A data-modifying CTE runs whether or not anything selects from it, so
    -- the outbox is resolved even though only the count is read below.
    resolved AS (
        UPDATE app.command_outbox AS o
        SET resolved_at = COALESCE(o.resolved_at, p_now),
            status = CASE WHEN o.status = 'leased' THEN 'published' ELSE o.status END,
            lease_owner = NULL,
            lease_expires_at = NULL
        FROM overdue
        WHERE o.tenant_id = p_tenant_id
          AND o.command_id = overdue.id
          AND o.resolved_at IS NULL
        RETURNING o.id
    )
    SELECT count(*) INTO v_expired FROM overdue;

    RETURN v_expired;
END
$$;

REVOKE ALL ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) TO vodoge_app;

COMMENT ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) IS
    'Retires one device''s commands that outlived expires_at, so they stop reporting as pending.';

COMMIT;
