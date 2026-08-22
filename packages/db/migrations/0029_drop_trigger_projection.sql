BEGIN;

-- Every device session has been dying with 42P10:
--
--   there is no unique or exclusion constraint matching the ON CONFLICT
--   specification
--
-- 0028 patched the messages insert inside accept_ingress to carry the
-- predicate its index needs, and the error did not move. The insert that
-- actually fails belongs to app.project_ingress_row(), a trigger 0008
-- installed on app.ingress.
--
-- 0013 moved the projection into accept_ingress -- "The projection belongs
-- inside accept_ingress rather than in a step after it" -- but never dropped
-- the trigger it replaced. Both have run on every envelope since: the trigger
-- fires first and writes the row, then the inline copy reaches ON CONFLICT DO
-- NOTHING and silently does nothing. The duplication was invisible while the
-- two agreed, so nothing surfaced it until they stopped agreeing.
--
-- The frozen 0008 copy is wrong three ways now, and would be wrong even with
-- its ON CONFLICT repaired:
--
--   * bearer is coerced into ('cellular','ims','sgs'). 0021 replaced that
--     vocabulary with ('cs','ims','nas','unknown'), so the coercion writes a
--     value messages_bearer_valid rejects. Fixing only the ON CONFLICT would
--     trade 42P10 for 23514 on the same envelope.
--   * modem_id is never resolved, so trigger-written messages do not name the
--     module that received them.
--   * last_seen_at is assigned outright. A reconnect replays older envelopes
--     and would walk the device clock backwards; the inline version takes
--     GREATEST for exactly that reason.
--
-- So the projection goes, and accept_ingress -- the copy that has been kept
-- current through 0026 and 0028 -- becomes the only writer of app.messages.
--
-- What does not go is the device touch. The trigger stamps last_seen_at for
-- every kind; accept_ingress only stamps it inside its DeviceState branch. A
-- device that sends nothing but SmsReceived would read as offline. Dropping
-- the trigger outright would introduce that regression while fixing the crash,
-- so the trigger stays and is reduced to the one job that is genuinely
-- per-envelope rather than per-kind.
CREATE OR REPLACE FUNCTION app.project_ingress_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Liveness only. Anything derived from the payload -- messages, modems,
    -- esim inventory, proxy traffic -- is projected by accept_ingress.
    --
    -- GREATEST rather than assignment: envelopes replayed after a reconnect
    -- arrive out of order, and an older one must not retire a newer sighting.
    -- state is deliberately not touched here; accept_ingress owns it and
    -- knows which kinds actually carry one.
    UPDATE app.devices
       SET last_seen_at = GREATEST(
               COALESCE(last_seen_at, NEW.received_at),
               NEW.received_at
           ),
           updated_at = now()
     WHERE id = NEW.device_id
       AND tenant_id = NEW.tenant_id;

    RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.project_ingress_row() IS
    'Stamps app.devices.last_seen_at for every ingress row. Payload projection lives in app.accept_ingress.';

COMMIT;
