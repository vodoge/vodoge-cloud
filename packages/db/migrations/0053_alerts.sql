-- What the agent said was wrong, without anybody having to ask.
--
-- The log is now readable from the cloud, but reading it is something a person
-- has to think to do, and a fault nobody thinks to look for is a fault nobody
-- hears about. The `/dev/cdc-wdm1` transport error on this bench repeated
-- every poll for hours with nothing upstream aware of it.
--
-- `Alert` has been in the contract and in the message catalogue since v1 and
-- was never emitted and never stored: a shape with no producer and no
-- consumer. This is the consumer.
--
-- # Throttled at the edge, not here
--
-- Most faults here repeat on a loop -- the poll runs every few seconds, so a
-- dead port produces an error every few seconds for as long as it stays dead.
-- The agent announces a code when it starts and then at most once per window
-- while it persists, carrying `repeats` in its context. That is why this table
-- has no de-duplication of its own: the row count is already the number of
-- times somebody should have been told, not the number of times it happened.
BEGIN;

CREATE TABLE IF NOT EXISTS app.alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    device_id uuid NOT NULL REFERENCES app.devices (id) ON DELETE CASCADE,
    level text NOT NULL,
    -- A constant the agent chose, never a formatted message: it is what the
    -- edge's throttle groups by, and it is what a rule would one day match on.
    code text NOT NULL,
    message text NOT NULL,
    -- Whatever varies -- a port, an IMEI, how many occurrences were held back.
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alerts_level_known
        CHECK (level IN ('info', 'warning', 'error', 'critical')),
    CONSTRAINT alerts_code_shape
        CHECK (code ~ '^[a-z0-9_]{1,128}$'),
    CONSTRAINT alerts_message_shape
        CHECK (length(message) BETWEEN 1 AND 1024),
    CONSTRAINT alerts_context_is_object
        CHECK (jsonb_typeof(context) = 'object')
);

-- The console's query is "this tenant, newest first", optionally one device.
CREATE INDEX IF NOT EXISTS alerts_recent
    ON app.alerts (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS alerts_by_device
    ON app.alerts (tenant_id, device_id, occurred_at DESC);

ALTER TABLE app.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.alerts
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.alerts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.alerts TO vodoge_app;
ALTER TABLE app.alerts OWNER TO vodoge_owner;

COMMENT ON TABLE app.alerts IS
    'Faults the agent announced. Throttled at the edge: one row per code per window, with how many occurrences were held back in context.repeats.';

-- Projection, additive for the same reason the candidate one is: the
-- three-hundred-line app.accept_ingress is the path every uplink kind takes,
-- and a mistake in a copy of it breaks ingest for everything.
CREATE OR REPLACE FUNCTION app.project_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    IF NEW.kind <> 'Alert' THEN
        RETURN NEW;
    END IF;

    -- A payload the constraints would reject is dropped rather than allowed to
    -- abort the ingest transaction: the envelope has already been accepted and
    -- acknowledged by this point, and failing here would roll back the
    -- sequence commit and make the device resend for ever.
    BEGIN
        INSERT INTO app.alerts (
            tenant_id, device_id, level, code, message, context, occurred_at
        ) VALUES (
            NEW.tenant_id,
            NEW.device_id,
            COALESCE(NEW.payload ->> 'level', 'error'),
            COALESCE(NEW.payload ->> 'code', 'unknown'),
            COALESCE(NULLIF(NEW.payload ->> 'message', ''), 'no message'),
            COALESCE(NEW.payload -> 'context', '{}'::jsonb),
            to_timestamp(COALESCE((NEW.payload ->> 'occurred_at')::bigint, 0) / 1000.0)
        );
    EXCEPTION WHEN others THEN
        RAISE WARNING 'alert not projected for device %: %', NEW.device_id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_alerts ON app.ingress;
CREATE TRIGGER project_alerts
    AFTER INSERT ON app.ingress
    FOR EACH ROW
    EXECUTE FUNCTION app.project_alerts();

COMMIT;
