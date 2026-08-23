-- Close the command ledger: retire commands the device accepted and never
-- answered, and let a settled outbox row leave 'pending'.
--
-- Two defects, one ledger.
--
-- (1) app.expire_overdue_commands filters `status IN ('queued', 'dispatched')`.
--     A command the device accepted and then never answered is in 'accepted',
--     so nothing can ever retire it. Command
--     e88c2af8-22e7-4a65-aace-82b690abd643 was issued 2026-08-22 09:26:38+00,
--     expired 09:36:38+00, and the console has reported it as waiting for the
--     device ever since -- a wait that cannot end, because PendingForDevice
--     filters on `expires_at > now` and stopped offering it the moment it
--     lapsed.
--
-- (2) app.command_outbox.status has never left 'pending' on this deployment.
--     Measured before this migration: 97 rows, all 'pending', 96 of them
--     already resolved, published_at NULL everywhere, attempt_count 0
--     everywhere. The settle paths advance status with
--     `CASE WHEN status = 'leased' THEN 'published' ELSE status END`, which
--     assumes every wakeup was first claimed by a dispatcher. Nothing claims
--     them: dispatch.OutboxStore.MarkWakeupPublished has no implementation
--     outside tests, and those two all-zero columns are the production proof.
--     So the CASE never fires and command_outbox_pending_idx -- a partial index
--     on `status = 'pending'` -- covers every wakeup this system has ever
--     written and can never shrink.
--
-- They are the same account. That one undying command owns the single outbox
-- row that is 'pending' with resolved_at still NULL; the other 96 are settled
-- rows that were never allowed to say so.
--
-- Nothing here deletes command history. Ninety-seven command rows go in and
-- ninety-seven come out. Only status columns move.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Retire accepted-but-silent commands, and distinguish them in reports.
-- ---------------------------------------------------------------------------
--
-- 'accepted' joins the predicate. The reason code does not: a command that was
-- never handed to a device and a command the device took and never answered
-- are different faults with different fixes -- the first points at delivery,
-- the second at the edge or the modem -- and collapsing them into one
-- 'cloud_expired' bucket makes the distinction unrecoverable after the fact.
--
-- The outbox update no longer asks whether the row was leased. A command with
-- a terminal status has no wakeup left to send whether or not anyone ever
-- claimed it, and both app.claim_command_outbox and
-- app.requeue_unresolved_outbox already refuse rows with resolved_at set, so
-- the row is unreachable to every scheduler either way. Clearing the lease
-- columns is required, not cosmetic: command_outbox_lease_shape forbids a
-- non-leased row from holding lease_owner or lease_expires_at, and violating
-- it would raise inside a live device transaction.
--
-- published_at stays NULL on purpose. No wakeup was published. resolved_at
-- already records when the row settled, and requeue_unresolved_outbox reads
-- published_at only for rows with resolved_at IS NULL, so the NULL is never
-- compared. Writing a synthetic publish time would erase the one signal that
-- separates a wakeup that really went out from one that never did.

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
        RETURNING c.id
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
    )
    SELECT count(*) INTO v_expired FROM overdue;

    RETURN v_expired;
END
$$;

REVOKE ALL ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) TO vodoge_app;

COMMENT ON FUNCTION app.expire_overdue_commands(uuid, uuid, timestamptz) IS
    'Retires one device''s commands that outlived expires_at, including ones the device accepted and never answered, so they stop reporting as pending.';

-- ---------------------------------------------------------------------------
-- 2. Backfill the outbox rows that settled but were never allowed to say so.
-- ---------------------------------------------------------------------------
--
-- resolved_at IS NOT NULL is the definition of a finished wakeup, so these
-- rows have been terminal all along; only the column disagreed. 96 rows at the
-- time of writing.

UPDATE app.command_outbox
SET status = 'published',
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE resolved_at IS NOT NULL
  AND status <> 'published';

-- ---------------------------------------------------------------------------
-- 3. Retire the commands the new predicate now covers, everywhere.
-- ---------------------------------------------------------------------------
--
-- app.expire_overdue_commands is per-device and runs on device resume, which
-- is the only tenant-scoped path available at runtime: app.tenants carries
-- FORCE row-level security under `id = app.current_tenant_id()`, so nothing --
-- not even a SECURITY DEFINER function owned by the table owner -- can
-- enumerate tenants to sweep them. A migration is the one context where that
-- restriction lifts, because it runs as the cluster superuser. So the one-shot
-- catch-up belongs here rather than waiting on each device to reconnect.
--
-- This is the new predicate applied globally, deliberately including
-- queued/dispatched (currently zero rows) so the backfill and the function
-- cannot disagree about what "overdue" means.

WITH overdue AS (
    UPDATE app.commands AS c
    SET status = 'expired',
        completed_at = now(),
        updated_at = now(),
        result = jsonb_build_object(
            'status', 'expired',
            'completed_at', now(),
            'attempts', 0,
            'reason_code', CASE
                WHEN c.status = 'accepted' THEN 'cloud_expired_after_accept'
                ELSE 'cloud_expired'
            END
        )
    WHERE c.status IN ('queued', 'dispatched', 'accepted')
      AND c.expires_at <= now()
    RETURNING c.tenant_id, c.id
)
UPDATE app.command_outbox AS o
SET resolved_at = COALESCE(o.resolved_at, now()),
    status = 'published',
    lease_owner = NULL,
    lease_expires_at = NULL
FROM overdue
WHERE o.tenant_id = overdue.tenant_id
  AND o.command_id = overdue.id
  AND o.resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Narrow the pending index to what the claim query actually asks for.
-- ---------------------------------------------------------------------------
--
-- app.claim_command_outbox and app.requeue_unresolved_outbox both require
-- resolved_at IS NULL, so a settled row was never a candidate; the index was
-- carrying it anyway. Adding that term makes the index match its only readers
-- and, more usefully, means a future settle path that forgets to move status
-- still cannot grow this index. Step 2 already emptied the backlog -- this is
-- so it stays empty.

DROP INDEX IF EXISTS app.command_outbox_pending_idx;
CREATE INDEX command_outbox_pending_idx
    ON app.command_outbox (available_at, id)
    WHERE status = 'pending' AND resolved_at IS NULL;

COMMIT;
