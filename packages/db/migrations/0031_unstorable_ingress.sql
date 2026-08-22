-- A record the database can never store must still consume its sequence.
--
-- The uplink is a contiguous journal: the device keeps every record until the
-- cloud acknowledges a committed prefix that covers it, and the prefix cannot
-- advance past a sequence that was never written. So a record that is refused
-- on structural grounds is refused again on every reconnect, forever, and
-- everything queued behind it waits behind it.
--
-- Three SMS bodies carrying a NUL did exactly this. The gateway now strips
-- NULs before the insert, which makes those particular records storable, but
-- that is a fix for one cause. This is the fix for the shape of the problem:
-- whatever the next unstorable record turns out to be, it costs one record
-- instead of the device.
--
-- Both alternatives are worse. Acknowledging without writing tells the device
-- the record is safe and it deletes its only copy, leaving a hole neither side
-- can fill -- that is how three thousand records were stranded. Never
-- acknowledging keeps the record but stops the device.
--
-- So the sequence is filled with a marker that says what was lost and why. The
-- payload never reaches a projection: the point of the tombstone is that the
-- original could not be projected.

BEGIN;

CREATE OR REPLACE FUNCTION app.record_unstorable_ingress(
    p_tenant_id uuid,
    p_device_id uuid,
    p_seq bigint,
    p_envelope_id uuid,
    p_kind text,
    p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
    v_inserted boolean;
BEGIN
    IF p_seq <= 0 THEN
        RAISE EXCEPTION 'ingress seq must be positive, got %', p_seq
            USING ERRCODE = '22023';
    END IF;

    -- Deliberately not routed through accept_ingress. That function validates
    -- the kind against the sequenced uplink kinds and then projects the
    -- payload; a tombstone is neither, and reusing it would mean teaching the
    -- projection to recognise a kind it must never act on.
    INSERT INTO app.ingress (
        tenant_id, device_id, seq, envelope_id, kind, payload
    ) VALUES (
        p_tenant_id,
        p_device_id,
        p_seq,
        p_envelope_id,
        'Unstorable',
        jsonb_build_object(
            'original_kind', p_kind,
            -- The reason is a database error string. It is recorded so the
            -- loss is explainable months later, when the only trace left is
            -- this row.
            'reason', left(COALESCE(p_reason, ''), 2000),
            'recorded_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
    )
    -- A replay of the same dropped record must resolve, not raise. The device
    -- has no way to know the cloud already tombstoned it.
    ON CONFLICT (device_id, seq) DO NOTHING
    RETURNING true INTO v_inserted;

    IF COALESCE(v_inserted, false) THEN
        RETURN 'inserted';
    END IF;
    RETURN 'duplicate';
END
$$;

REVOKE ALL ON FUNCTION app.record_unstorable_ingress(uuid, uuid, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_unstorable_ingress(uuid, uuid, bigint, uuid, text, text) TO vodoge_app;

COMMENT ON FUNCTION app.record_unstorable_ingress(uuid, uuid, bigint, uuid, text, text) IS
    'Fills one sequence with a tombstone so a permanently unstorable record cannot stall the device uplink.';

COMMIT;
