BEGIN;

-- Removing a device touches eleven tables in an order dictated by foreign
-- keys. Doing it from the gateway would mean granting the application role
-- DELETE on app.ingress, app.commands and app.device_certificates — the power
-- to erase any device's whole history, held permanently, to support one
-- operation.
--
-- So it is one function instead. The application role gets EXECUTE on exactly
-- this and nothing more.
--
-- SECURITY DEFINER, but not a way around isolation: the owner is subject to
-- FORCE ROW LEVEL SECURITY like everyone else, so every statement below still
-- sees only the calling tenant's rows. A device id from another tenant matches
-- nothing and the function reports that it did not exist.
CREATE OR REPLACE FUNCTION app.delete_device(p_device_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_existed boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM app.devices WHERE id = p_device_id) INTO v_existed;
    IF NOT v_existed THEN
        RETURN false;
    END IF;

    DELETE FROM app.messages WHERE device_id = p_device_id;

    DELETE FROM app.proxy_traffic
     WHERE instance_id IN (SELECT id FROM app.proxy_instances WHERE device_id = p_device_id);
    DELETE FROM app.proxy_instances WHERE device_id = p_device_id;

    DELETE FROM app.command_delivery_attempts
     WHERE command_id IN (SELECT id FROM app.commands WHERE device_id = p_device_id);
    DELETE FROM app.command_receipts
     WHERE command_id IN (SELECT id FROM app.commands WHERE device_id = p_device_id);
    DELETE FROM app.command_outbox
     WHERE command_id IN (SELECT id FROM app.commands WHERE device_id = p_device_id);
    DELETE FROM app.commands WHERE device_id = p_device_id;

    DELETE FROM app.ingress WHERE device_id = p_device_id;
    DELETE FROM app.device_certificates WHERE device_id = p_device_id;

    -- An enrollment code outlives the device it enrolled. It records an act,
    -- its device reference is nullable, and destroying it would erase how the
    -- device came to exist along with the device itself.
    UPDATE app.enrollment_codes SET device_id = NULL WHERE device_id = p_device_id;

    DELETE FROM app.modems WHERE device_id = p_device_id;
    DELETE FROM app.devices WHERE id = p_device_id;

    RETURN true;
END
$$;

ALTER FUNCTION app.delete_device(uuid) OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.delete_device(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_device(uuid) TO vodoge_app;

INSERT INTO app.schema_migrations (version, name) VALUES (24, '0024_delete_device')
ON CONFLICT (version) DO NOTHING;

COMMIT;
