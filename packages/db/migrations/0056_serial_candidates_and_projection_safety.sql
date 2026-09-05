-- Two fixes to the modem-candidate projection from 0050, both about the same
-- failure: a candidate the table refuses raises inside an AFTER INSERT trigger
-- on app.ingress, and there is nothing to catch it.
--
-- # 1. `serial` is a real transport
--
-- 0050's CHECK admits `qmi` and `at`. It is internally contradictory as
-- written: the state CHECK on the same table admits `found` and `claimed`, and
-- `claimed` is produced by exactly one code path in the agent -- the manual
-- serial candidate -- which reports `transport = 'serial'`. The table therefore
-- permits a state that can only be reached over a transport it forbids.
--
-- Verified in the agent, 2026-09-05: `DiscoveryState::Claimed` is written at
-- one site, and that site writes `DiscoveryTransport::Serial`.
--
-- This is not new capability. It is the schema being corrected to describe the
-- implementation it was always written for, which is why it amends v1 rather
-- than opening v2. The wire contract was widened in the same change
-- (`DiscoveryCandidate.transport`), so the gateway's conformance check stops
-- reporting these as violations at the same moment the table stops rejecting
-- them.
--
-- # 2. The projection must not be able to make a device resend for ever
--
-- 0050's trigger has no EXCEPTION handler. A single candidate the table refuses
-- -- a `serial` one until this migration, a state nobody has added yet, a
-- `last_seen` that will not cast -- raises, and the raise propagates out of an
-- AFTER INSERT trigger and rolls back the ingress row. The envelope has already
-- been accepted and acknowledged by then, so the device resends the same frame,
-- and the same candidate fails again. One unusual stick, and that device
-- uplinks nothing else for as long as it stays plugged in.
--
-- 0055 already carries this reasoning and the handler that answers it, for the
-- managed-modem projection. This is the same guard on the projection next to
-- it. Fixing only the CHECK would leave the trap armed for the next value
-- somebody adds to an enum on one side.
--
-- The handler wraps the loop **and** the delete, so the block is one
-- subtransaction: either the agent's whole candidate list is projected, or none
-- of it is. That is the behaviour worth having rather than an accident of where
-- the BEGIN went -- the delete removes every row the agent did not report, so
-- running it against a list that stopped halfway would retire candidates that
-- are plugged in and answering.
BEGIN;

ALTER TABLE app.modem_candidates
    DROP CONSTRAINT IF EXISTS modem_candidates_transport_known;

ALTER TABLE app.modem_candidates
    ADD CONSTRAINT modem_candidates_transport_known
        CHECK (transport IN ('qmi', 'at', 'serial'));

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

    -- Swallowed on purpose; see the header. Raising here rolls back an
    -- envelope the device has already been told was accepted.
    BEGIN
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
    EXCEPTION WHEN others THEN
        RAISE WARNING 'modem candidates not projected for device %: %',
            NEW.device_id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

COMMENT ON CONSTRAINT modem_candidates_transport_known ON app.modem_candidates IS
    'qmi and at are probed automatically; serial is the manual path, and it is the only one that can produce state = claimed.';

COMMIT;
