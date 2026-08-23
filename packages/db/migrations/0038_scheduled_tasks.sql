-- Scheduled tasks: recurring commands the cloud issues without an operator.
--
-- This is the keep-the-number use case. A prepaid SIM that sends nothing for
-- weeks gets reclaimed by the carrier, so something has to send one SMS on a
-- cadence, forever, unattended. Nothing in the gateway could do that: the rules
-- package extracts verification codes out of arriving messages and has no timer
-- in it, and every command this deployment has ever issued came from a console
-- click.
--
-- ---------------------------------------------------------------------------
-- Why there is no global scheduler
-- ---------------------------------------------------------------------------
--
-- The obvious build is a cron loop that scans every tenant's due tasks. It is
-- not available here, and not by oversight. app.tenants carries FORCE row-level
-- security under `id = app.current_tenant_id()`, which binds the table owner as
-- well, so nothing -- not even a SECURITY DEFINER function owned by that owner
-- -- can enumerate tenants. 0033 recorded the same wall when it had to pick a
-- trigger for command expiry.
--
-- So the tenant has to arrive from outside the database. Two carriers were
-- available. The live device sessions won:
--
--   * session.Hub already holds (tenant_id, device_id) for every connected edge
--     box, in memory, taken from the mTLS certificate subject. It needs no
--     query against app.tenants and cannot drift from it, because a session
--     only exists if the certificate that made it was issued to that tenant.
--   * A scheduled SMS needs an online device anyway. A tenant with nothing
--     connected has nothing to schedule onto, so the set of tenants worth
--     ticking is exactly the set this carrier produces.
--   * It is the same shape as the trigger 0033 chose for expiry, which is why
--     L3 -- sweeping overdue commands -- hangs off this tick as a second
--     tenant-scoped path rather than needing a third mechanism.
--
-- The rejected alternative was a Redis due-set, which internal/wakeup already
-- has a client for. Redis would become a second answer to "which tenants exist"
-- that can disagree with the database, it is optional in this deployment
-- (REDIS_URL may be empty, and the gateway is required to keep serving without
-- it), and a scheduler that silently does nothing when an optional dependency
-- is missing is the worst of the available failures.
--
-- The honest cost, stated so nobody has to rediscover it: a tenant with no
-- connected device does not tick. Its occurrences go stale and are recorded as
-- skipped rather than fired late. That is the same convergence property 0033
-- accepted, and it is visible in last_status instead of being silent.
--
-- ---------------------------------------------------------------------------
-- Why an occurrence number, and why the idempotency key is derived from it
-- ---------------------------------------------------------------------------
--
-- The one unacceptable failure for this feature is sending the same message
-- twice. A command that has reached a modem cannot be recalled, and nothing
-- downstream can tell a duplicate from a second intention -- app.enqueue_command
-- treats two sends as distinct precisely because two AT+CSQ readings are two
-- readings, not one repeated.
--
-- So firing is not "remember when I last ran and add an interval". Each task has
-- a fixed anchor_at, and occurrence n means the instant
-- anchor_at + n * interval_seconds. The idempotency key handed to
-- app.enqueue_command is derived from (task id, occurrence) and from nothing
-- else. commands_tenant_idempotency_key is UNIQUE, and enqueue_command answers a
-- repeat of a matching key by returning the command that already exists without
-- writing a second outbox row. That makes double delivery impossible through the
-- only door this feature opens, rather than merely unlikely:
--
--   * two gateway processes computing the same occurrence produce one command;
--   * a crash between enqueue and bookkeeping is repaired by re-running, which
--     lands on the same key;
--   * a lease that lapses while a worker is stuck produces a second attempt that
--     cannot become a second message.
--
-- last_occurrence is the high-water mark, advanced with GREATEST so a slow
-- worker finishing after a faster one cannot wind it backwards.
--
-- The bookkeeping is committed in the same transaction as the enqueue (see
-- schedule.SQL.Fire), so "a command exists for occurrence n" and "the task has
-- advanced past n" cannot disagree. Splitting them was the tempting simpler
-- build and it has a real hole: advance-then-enqueue silently drops an
-- occurrence on a crash, and enqueue-then-advance is only safe because of the
-- derived key -- which is exactly the property that should not be load-bearing
-- in two places at once.

BEGIN;

CREATE TABLE IF NOT EXISTS app.scheduled_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,

    -- What the tick does when this task comes due.
    --
    -- 'command' enqueues a durable command through app.enqueue_command, which is
    -- the same path a console click takes -- deliberately, so a scheduled send
    -- and a manual send cannot drift into two different delivery stories.
    --
    -- 'public_ip_check' does not touch a device at all. The agent already
    -- reports the box's egress address in every DeviceState, so asking again
    -- would be a round trip for a fact the cloud is already holding; the task
    -- reads what was last reported and records it, which is what turns a number
    -- on a page into something with a history and a watcher.
    action text NOT NULL,
    command_kind app.command_kind,

    -- How the target is found, evaluated at fire time rather than stored.
    --
    -- {"mode":"card","iccid":"..."} is the one that matters for keeping a number
    -- alive: the schedule names the SIM, and whichever module currently holds it
    -- is resolved on each run. Pinning a modem IMEI instead would keep sending
    -- from the wrong card the day the SIM is moved, and it would look like it
    -- was working.
    --
    -- {"mode":"device","device_id":"...","modem_imei":"..."} names the box. The
    -- IMEI is required there for any command that needs a module, and is not
    -- guessed when a device has several: choosing a SIM to send from on the
    -- caller's behalf is how the wrong number gets billed.
    selector jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- The command's own fields (to, body, command, ...) in the shape the console
    -- POSTs to /v1/commands, so commands.BuildPayload stays the single
    -- validator. A second schema for scheduled commands would be a second set of
    -- rules to keep in step.
    request jsonb NOT NULL DEFAULT '{}'::jsonb,

    interval_seconds integer NOT NULL,
    -- The fixed origin of the occurrence grid. Never advanced; moving it would
    -- renumber every past occurrence and make already-issued idempotency keys
    -- unreachable, which is the one way to reintroduce double sending.
    anchor_at timestamptz NOT NULL DEFAULT now(),
    last_occurrence bigint NOT NULL DEFAULT 0,

    last_run_at timestamptz,
    last_status text,
    last_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- No foreign key to app.commands on purpose. 0024's device deletion removes
    -- command history, and a composite FK cannot be ON DELETE SET NULL here
    -- because tenant_id is NOT NULL -- so the reference would either block
    -- device deletion or fail it. This column is a pointer for the console, not
    -- an integrity claim.
    last_command_id uuid,

    lease_owner text,
    lease_expires_at timestamptz,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT scheduled_tasks_tenant_id_id_key UNIQUE (tenant_id, id),
    CONSTRAINT scheduled_tasks_tenant_name_key UNIQUE (tenant_id, name),
    CONSTRAINT scheduled_tasks_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT scheduled_tasks_action_valid
        CHECK (action IN ('command', 'public_ip_check')),
    -- A 'command' task without a kind would fail every run; a non-command task
    -- carrying one would be a lie about what it does.
    CONSTRAINT scheduled_tasks_kind_matches_action
        CHECK ((action = 'command') = (command_kind IS NOT NULL)),
    -- The floor is one minute because the tick that drives this runs on a
    -- coarser clock than a second, and a task that can come due more than once
    -- between ticks would report as skipped for reasons the operator cannot see.
    -- The ceiling is a week: beyond that the anchor drifts out of any useful
    -- relationship with wall-clock time of day.
    CONSTRAINT scheduled_tasks_interval_sane
        CHECK (interval_seconds BETWEEN 60 AND 604800),
    CONSTRAINT scheduled_tasks_occurrence_not_negative CHECK (last_occurrence >= 0),
    CONSTRAINT scheduled_tasks_selector_is_object CHECK (jsonb_typeof(selector) = 'object'),
    CONSTRAINT scheduled_tasks_request_is_object CHECK (jsonb_typeof(request) = 'object'),
    CONSTRAINT scheduled_tasks_last_detail_is_object CHECK (jsonb_typeof(last_detail) = 'object'),
    -- Same shape rule app.command_outbox uses: a lease is both columns or
    -- neither, so a half-cleared lease cannot make a task unclaimable forever.
    CONSTRAINT scheduled_tasks_lease_shape
        CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS scheduled_tasks_enabled_idx
    ON app.scheduled_tasks (tenant_id, id)
    WHERE enabled;

ALTER TABLE app.scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scheduled_tasks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.scheduled_tasks;
CREATE POLICY tenant_isolation ON app.scheduled_tasks
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.scheduled_tasks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.scheduled_tasks TO vodoge_app;

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------
--
-- Returns at most one occurrence per task per call -- the next one, not the
-- current one. A worker that fell behind catches up one occurrence per tick
-- instead of emitting a burst, and the caller decides whether an occurrence is
-- too old to be worth sending at all, which is why the current occurrence is
-- reported alongside it.
--
-- Output columns are prefixed because RETURNS TABLE names become plpgsql
-- variables that shadow column references of the same name; `id` and `name`
-- would make the body ambiguous rather than wrong, which is worse.
CREATE OR REPLACE FUNCTION app.claim_due_scheduled_tasks(
    p_tenant_id uuid,
    p_owner text,
    p_now timestamptz,
    p_lease interval,
    p_limit integer
)
RETURNS TABLE (
    task_id uuid,
    task_name text,
    task_action text,
    task_command_kind text,
    task_selector jsonb,
    task_request jsonb,
    task_interval_seconds integer,
    task_occurrence bigint,
    task_occurrence_at timestamptz,
    task_due_occurrence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match scheduled task tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_limit < 1 OR p_limit > 200 THEN
        RAISE EXCEPTION 'scheduled task claim limit must be between 1 and 200'
            USING ERRCODE = '22023';
    END IF;

    IF p_lease <= interval '0 seconds' THEN
        RAISE EXCEPTION 'scheduled task lease must be positive'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT t.id AS candidate_id,
               floor(
                   extract(epoch FROM (p_now - t.anchor_at)) / t.interval_seconds
               )::bigint AS candidate_due
          FROM app.scheduled_tasks AS t
         WHERE t.tenant_id = p_tenant_id
           AND t.enabled
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= p_now)
           AND floor(
                   extract(epoch FROM (p_now - t.anchor_at)) / t.interval_seconds
               )::bigint > t.last_occurrence
         ORDER BY t.id
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.scheduled_tasks AS t
       SET lease_owner = p_owner,
           lease_expires_at = p_now + p_lease,
           updated_at = now()
      FROM candidates AS c
     WHERE t.id = c.candidate_id
 RETURNING t.id,
           t.name,
           t.action,
           t.command_kind::text,
           t.selector,
           t.request,
           t.interval_seconds,
           -- last_occurrence is not in the SET list, so RETURNING gives the
           -- value the row had before the lease was written.
           t.last_occurrence + 1,
           t.anchor_at + make_interval(
               secs => (t.interval_seconds::double precision * (t.last_occurrence + 1))
           ),
           c.candidate_due;
END
$$;

REVOKE ALL ON FUNCTION app.claim_due_scheduled_tasks(uuid, text, timestamptz, interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_scheduled_tasks(uuid, text, timestamptz, interval, integer) TO vodoge_app;

COMMENT ON FUNCTION app.claim_due_scheduled_tasks(uuid, text, timestamptz, interval, integer) IS
    'Leases one tenant''s due scheduled tasks and reports the next occurrence each one owes, one occurrence per call.';

-- ---------------------------------------------------------------------------
-- Finishing
-- ---------------------------------------------------------------------------
--
-- p_occurrence NULL means "release the lease and record what happened, but do
-- not advance". That is the outcome for a failure in the preparation stage --
-- resolving the target, building the payload -- which is the only stage where
-- retrying is safe, because nothing has been handed to a modem yet. Anything
-- that has reached app.enqueue_command advances, whether it succeeded or
-- collided, because after that point a repeat is a repeat.
CREATE OR REPLACE FUNCTION app.finish_scheduled_task(
    p_tenant_id uuid,
    p_task_id uuid,
    p_occurrence bigint,
    p_status text,
    p_detail jsonb,
    p_command_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_updated integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match scheduled task tenant'
            USING ERRCODE = '42501';
    END IF;

    UPDATE app.scheduled_tasks AS t
       SET last_occurrence = CASE
               WHEN p_occurrence IS NULL THEN t.last_occurrence
               -- GREATEST, not assignment: a worker whose lease lapsed can still
               -- be running, and letting it finish would otherwise pull the
               -- high-water mark back and re-issue occurrences that the worker
               -- which replaced it has already dealt with.
               ELSE GREATEST(t.last_occurrence, p_occurrence)
           END,
           last_run_at = p_now,
           last_status = p_status,
           last_detail = COALESCE(p_detail, '{}'::jsonb),
           last_command_id = p_command_id,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
     WHERE t.tenant_id = p_tenant_id
       AND t.id = p_task_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END
$$;

REVOKE ALL ON FUNCTION app.finish_scheduled_task(uuid, uuid, bigint, text, jsonb, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finish_scheduled_task(uuid, uuid, bigint, text, jsonb, uuid, timestamptz) TO vodoge_app;

COMMENT ON FUNCTION app.finish_scheduled_task(uuid, uuid, bigint, text, jsonb, uuid, timestamptz) IS
    'Releases a scheduled task lease and records the run; a NULL occurrence leaves the high-water mark alone so a preparation failure is retried.';

-- ---------------------------------------------------------------------------
-- L3: tenant-wide command expiry
-- ---------------------------------------------------------------------------
--
-- app.expire_overdue_commands is per-device and fires when a device resumes,
-- which 0033 chose because resume was then the only tenant-scoped path that ran
-- on its own. Its stated cost was that a device which never reconnects keeps its
-- stale rows forever -- and that is precisely the device whose rows go stale.
--
-- The scheduler tick is a second such path, and a better one for this job: it
-- holds tenant context without needing the device it is sweeping to be the one
-- that provided it. So this form drops the device filter and retires every
-- overdue command in the tenant, including those belonging to devices that are
-- offline or gone.
--
-- The body is otherwise 0037's, deliberately: two spellings of "expired" would
-- be a reporting bug waiting to happen, and the reason codes have to keep
-- distinguishing a command that was never handed over from one the device took
-- and never answered.
CREATE OR REPLACE FUNCTION app.expire_overdue_tenant_commands(
    p_tenant_id uuid,
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
                'reason_code', CASE
                    WHEN c.status = 'accepted' THEN 'cloud_expired_after_accept'
                    ELSE 'cloud_expired'
                END
            )
        WHERE c.tenant_id = p_tenant_id
          AND c.status IN ('queued', 'dispatched', 'accepted')
          AND c.expires_at <= p_now
        RETURNING c.id
    ),
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

REVOKE ALL ON FUNCTION app.expire_overdue_tenant_commands(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_overdue_tenant_commands(uuid, timestamptz) TO vodoge_app;

COMMENT ON FUNCTION app.expire_overdue_tenant_commands(uuid, timestamptz) IS
    'Retires every overdue command in one tenant, including devices that never reconnect; driven by the scheduler tick.';

-- ---------------------------------------------------------------------------
-- Legacy 0002 lifecycle functions: recording why they are left alone
-- ---------------------------------------------------------------------------
--
-- app.expire_command, app.apply_command_receipt and app.apply_command_result
-- still advance app.command_outbox with
-- `CASE WHEN status = 'leased' THEN 'published' ELSE status END`, the same
-- leased-only assumption 0037 removed from the settle paths that are actually
-- reached. They have no Go caller -- the live paths are
-- commands.SQLLifecycle.RecordReceipt/RecordResult and, from this migration on,
-- schedule.SQL.Fire -- and this feature does not give them one: the scheduler
-- enqueues through app.enqueue_command and settles through the same lifecycle
-- code a console click uses, precisely so a scheduled command and a clicked
-- command cannot end up with two different accounting stories.
--
-- Rewriting them would mean editing three functions that nothing calls, with no
-- test that can fail if the edit is wrong. Dropping them is a larger claim than
-- this change has evidence for -- dispatch.Dispatcher is written against them
-- and is one wiring decision away from being live. So they are commented
-- instead, which is the part that was actually missing: the next person to read
-- them should not have to re-derive that they are unreached.
COMMENT ON FUNCTION app.expire_command(uuid, uuid, timestamptz) IS
    'Unreached since 0002: dispatch.Dispatcher has no live wiring. Its leased-only outbox CASE was superseded by 0037; the live paths are app.expire_overdue_commands and app.expire_overdue_tenant_commands.';

COMMIT;
