-- Modem-shaped endpoints an agent has seen and has not been told to probe.
--
-- The edge panel has listed these since it existed, and has a button that
-- approves one for an identity probe. Nothing carried them to the cloud, so an
-- operator who works from the console -- which is most of the time -- could not
-- tell that a stick had been plugged into an edge machine at all. "Add a
-- device" was, in practice, something only somebody on that LAN could do.
--
-- This is the honest cloud form of that action. It is NOT a hand-typed device:
-- enrolment is certificate-based and a device the console invented would have
-- nothing to connect with. What the console approves is something the agent
-- already saw, addressed by the key the agent gave it.
--
-- # Why a trigger rather than a change to app.accept_ingress
--
-- The projection in accept_ingress is three hundred lines and is the path
-- every uplink kind takes. Adding to it means replacing the whole function,
-- and a mistake anywhere in that copy breaks ingest for everything. This is
-- additive: a trigger that reads one key out of one kind of payload and
-- touches one table nothing else writes.
BEGIN;

CREATE TABLE IF NOT EXISTS app.modem_candidates (
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    device_id uuid NOT NULL REFERENCES app.devices (id) ON DELETE CASCADE,
    -- What a claim addresses. Derived by the agent from stable USB topology
    -- rather than the Linux device name, which changes on re-enumeration.
    candidate_key text NOT NULL,
    usb_device text,
    transport text NOT NULL,
    control_port text NOT NULL,
    vendor_id text,
    product_id text,
    -- found = seen and never written to; claimed = approved for a probe; the
    -- rest describe what a probe found.
    state text NOT NULL,
    imei text,
    detail text NOT NULL DEFAULT '',
    last_seen timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, device_id, candidate_key),
    CONSTRAINT modem_candidates_transport_known
        CHECK (transport IN ('qmi', 'at')),
    CONSTRAINT modem_candidates_state_known
        CHECK (state IN ('manageable', 'probe_failed', 'at_only', 'found', 'claimed'))
);

CREATE INDEX IF NOT EXISTS modem_candidates_by_device
    ON app.modem_candidates (tenant_id, device_id, state);

ALTER TABLE app.modem_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.modem_candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.modem_candidates
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.modem_candidates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.modem_candidates TO vodoge_app;
ALTER TABLE app.modem_candidates OWNER TO vodoge_owner;

COMMENT ON TABLE app.modem_candidates IS
    'Endpoints an agent has seen but not written to, projected from DeviceState. What the console approves for an identity probe; not a device, and not something the console can invent.';

-- Projection.
--
-- A DeviceState carries the agent's complete current list, so this is a
-- replacement rather than an upsert: an endpoint the agent has stopped
-- reporting has been unplugged, and leaving its row would offer an operator a
-- button that approves hardware that is no longer there.
--
-- A payload with no `discoveries` key at all is left alone rather than treated
-- as an empty list. That is what an older agent sends, and reading its silence
-- as "nothing is plugged in" would clear a list somebody is looking at.
CREATE OR REPLACE FUNCTION app.project_modem_candidates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_candidate jsonb;
    v_keys text[] := ARRAY[]::text[];
BEGIN
    IF NEW.kind <> 'DeviceState' OR NOT (NEW.payload ? 'discoveries') THEN
        RETURN NEW;
    END IF;

    FOR v_candidate IN
        SELECT value FROM jsonb_array_elements(
            COALESCE(NEW.payload -> 'discoveries', '[]'::jsonb)
        )
    LOOP
        CONTINUE WHEN COALESCE(v_candidate ->> 'candidate_key', '') = '';
        v_keys := v_keys || (v_candidate ->> 'candidate_key');

        INSERT INTO app.modem_candidates (
            tenant_id, device_id, candidate_key, usb_device, transport,
            control_port, vendor_id, product_id, state, imei, detail,
            last_seen, updated_at
        ) VALUES (
            NEW.tenant_id,
            NEW.device_id,
            v_candidate ->> 'candidate_key',
            NULLIF(v_candidate ->> 'usb_device', ''),
            COALESCE(v_candidate ->> 'transport', 'at'),
            COALESCE(v_candidate ->> 'control_port', ''),
            NULLIF(v_candidate ->> 'vendor_id', ''),
            NULLIF(v_candidate ->> 'product_id', ''),
            COALESCE(v_candidate ->> 'state', 'found'),
            NULLIF(v_candidate ->> 'imei', ''),
            COALESCE(v_candidate ->> 'detail', ''),
            to_timestamp(COALESCE((v_candidate ->> 'last_seen')::bigint, 0) / 1000.0),
            now()
        )
        ON CONFLICT (tenant_id, device_id, candidate_key) DO UPDATE
           SET usb_device   = excluded.usb_device,
               transport    = excluded.transport,
               control_port = excluded.control_port,
               vendor_id    = excluded.vendor_id,
               product_id   = excluded.product_id,
               state        = excluded.state,
               imei         = excluded.imei,
               detail       = excluded.detail,
               last_seen    = excluded.last_seen,
               updated_at   = now();
    END LOOP;

    DELETE FROM app.modem_candidates
     WHERE tenant_id = NEW.tenant_id
       AND device_id = NEW.device_id
       AND NOT (candidate_key = ANY (v_keys));

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_modem_candidates ON app.ingress;
CREATE TRIGGER project_modem_candidates
    AFTER INSERT ON app.ingress
    FOR EACH ROW
    EXECUTE FUNCTION app.project_modem_candidates();

COMMIT;
