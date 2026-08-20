BEGIN;

-- Project sequenced uplink into the console catalog. SMS uniqueness stays on
-- app.messages(device_id, seq). Device last_seen_at is updated for every
-- inserted ingress row so the device list can show online/offline without a
-- second write path.
CREATE OR REPLACE FUNCTION app.project_ingress_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_received timestamptz;
    v_bearer text;
    v_peer text;
    v_body text;
    v_epoch double precision;
BEGIN
    UPDATE app.devices
       SET last_seen_at = NEW.received_at,
           state = CASE
               WHEN NEW.kind = 'DeviceState' THEN NEW.payload
               ELSE state
           END
     WHERE id = NEW.device_id
       AND tenant_id = NEW.tenant_id;

    IF NEW.kind <> 'SmsReceived' THEN
        RETURN NEW;
    END IF;

    v_peer := COALESCE(NEW.payload->>'peer', '');
    v_body := COALESCE(NEW.payload->>'body', '');
    v_bearer := NEW.payload->>'bearer';
    IF v_bearer IS NULL OR v_bearer NOT IN ('cellular', 'ims', 'sgs') THEN
        v_bearer := 'cellular';
    END IF;

    v_received := NEW.received_at;
    IF jsonb_typeof(NEW.payload->'received_at') = 'number' THEN
        BEGIN
            v_epoch := (NEW.payload->>'received_at')::double precision;
            IF v_epoch > 1e12 THEN
                v_received := to_timestamp(v_epoch / 1000.0);
            ELSIF v_epoch > 0 THEN
                v_received := to_timestamp(v_epoch);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_received := NEW.received_at;
        END;
    END IF;

    INSERT INTO app.messages (
        tenant_id,
        device_id,
        direction,
        peer,
        body,
        bearer,
        received_at,
        seq,
        dedupe_key
    ) VALUES (
        NEW.tenant_id,
        NEW.device_id,
        'inbound',
        v_peer,
        v_body,
        v_bearer,
        v_received,
        NEW.seq,
        NEW.envelope_id::text
    )
    ON CONFLICT (device_id, seq) DO NOTHING;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ingress_project_row ON app.ingress;
CREATE TRIGGER ingress_project_row
AFTER INSERT ON app.ingress
FOR EACH ROW EXECUTE FUNCTION app.project_ingress_row();

COMMIT;
