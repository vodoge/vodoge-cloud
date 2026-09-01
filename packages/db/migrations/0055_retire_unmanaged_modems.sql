-- Retiring a modem row the edge no longer manages.
--
-- Until now a row was created by the first observation and never removed. That
-- was survivable while the agent adopted whatever it found, and stopped being
-- survivable when adoption became explicit: unmanage a module on the edge and
-- its cloud row simply stops being updated, sitting at its last observation
-- for ever. Two of those are on this bench right now -- Qualcomm sticks pulled
-- out of the hub, still listed as `offline` with a `last_seen_at` from the
-- morning.
--
-- 🔴 Marked, not deleted. `move history` was the user's own decision when the
-- model was chosen: unmanaging is a statement about the future, not a
-- retraction of what the module did. A delete would also have to answer what
-- happens to the messages and commands that reference it, and the answer
-- "nothing, they are kept" is exactly what a flag gives for free.
BEGIN;

ALTER TABLE app.modems
    ADD COLUMN IF NOT EXISTS managed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app.modems.managed IS
    'False once the edge stops listing this IMEI in managed_imeis. The row and everything referencing it are kept; the console hides it.';

-- Which modules an agent says it manages, applied to that device only.
--
-- Called from the DeviceState projection. Separate from it because the rule
-- has one dangerous edge -- an absent list means "the agent did not say",
-- never "the agent manages nothing" -- and that is easier to state and to test
-- as its own function than as four more lines inside a three-hundred-line one.
CREATE OR REPLACE FUNCTION app.apply_managed_modems(
    p_tenant_id uuid,
    p_device_id uuid,
    p_managed jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_imeis text[];
BEGIN
    -- 🔴 Absent is not empty. An agent that could not read its registry omits
    -- the key, and acting on that would unmanage a whole device on a
    -- transient store error. An empty array, by contrast, is a real statement
    -- -- nothing is adopted -- and retires every row.
    IF p_managed IS NULL OR jsonb_typeof(p_managed) <> 'array' THEN
        RETURN;
    END IF;

    SELECT COALESCE(array_agg(value), ARRAY[]::text[])
      INTO v_imeis
      FROM jsonb_array_elements_text(p_managed) AS value;

    UPDATE app.modems
       SET managed = (imei = ANY (v_imeis)),
           updated_at = now()
     WHERE tenant_id = p_tenant_id
       AND device_id = p_device_id
       AND managed <> (imei = ANY (v_imeis));
END;
$$;

-- Wired as its own trigger rather than as four more lines inside
-- `app.accept_ingress`.
--
-- That function is the path every uplink kind takes -- messages, receipts,
-- results, eSIM inventory, proxy traffic -- and a mistake inside it breaks
-- ingest for all of them, not just for modems. The alerts projection in 0053
-- was added the same way for the same reason, and it is the pattern worth
-- repeating: additive, independently droppable, and unable to take anything
-- else down with it.
CREATE OR REPLACE FUNCTION app.project_managed_modems()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    IF NEW.kind <> 'DeviceState' THEN
        RETURN NEW;
    END IF;

    -- Swallowed on purpose. The envelope has already been accepted and
    -- acknowledged by this point; raising here would roll back the sequence
    -- commit and make the device resend the same frame for ever.
    BEGIN
        PERFORM app.apply_managed_modems(
            NEW.tenant_id, NEW.device_id, NEW.payload -> 'managed_imeis'
        );
    EXCEPTION WHEN others THEN
        RAISE WARNING 'managed modems not applied for device %: %', NEW.device_id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_managed_modems ON app.ingress;
CREATE TRIGGER project_managed_modems
    AFTER INSERT ON app.ingress
    FOR EACH ROW
    EXECUTE FUNCTION app.project_managed_modems();

COMMIT;
