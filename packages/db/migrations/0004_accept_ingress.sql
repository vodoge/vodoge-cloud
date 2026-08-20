BEGIN;

-- Durable ingress policy used by the gateway. Duplicate (device_id, seq) with
-- identical content is a no-op; a different envelope is a conflict. The
-- contiguous prefix is computed from the table, never from the edge cursors.
CREATE OR REPLACE FUNCTION app.ingress_window(
    p_tenant_id uuid,
    p_device_id uuid
)
RETURNS TABLE (
    committed_through bigint,
    missing_ranges jsonb,
    more_missing boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_committed bigint := 0;
    v_prev bigint;
    v_seq bigint;
    v_from bigint;
    v_ranges jsonb := '[]'::jsonb;
    v_more boolean := false;
    v_count integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match ingress tenant'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(MAX(t.seq), 0)
      INTO v_committed
      FROM (
          SELECT i.seq,
                 ROW_NUMBER() OVER (ORDER BY i.seq) AS rn
            FROM app.ingress AS i
           WHERE i.tenant_id = p_tenant_id
             AND i.device_id = p_device_id
      ) AS t
     WHERE t.seq = t.rn;

    v_prev := v_committed;
    FOR v_seq IN
        SELECT i.seq
          FROM app.ingress AS i
         WHERE i.tenant_id = p_tenant_id
           AND i.device_id = p_device_id
           AND i.seq > v_committed
         ORDER BY i.seq
    LOOP
        IF v_seq > v_prev + 1 THEN
            IF v_count >= 128 THEN
                v_more := true;
                EXIT;
            END IF;
            v_from := v_prev + 1;
            v_ranges := v_ranges || jsonb_build_array(
                jsonb_build_object(
                    'from', (v_from)::text,
                    'through', (v_seq - 1)::text
                )
            );
            v_count := v_count + 1;
        END IF;
        v_prev := v_seq;
    END LOOP;

    committed_through := v_committed;
    missing_ranges := v_ranges;
    more_missing := v_more;
    RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION app.accept_ingress(
    p_tenant_id uuid,
    p_device_id uuid,
    p_seq bigint,
    p_envelope_id uuid,
    p_kind text,
    p_payload jsonb
)
RETURNS TABLE (
    status text,
    committed_through bigint,
    missing_ranges jsonb,
    more_missing boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_existing app.ingress%ROWTYPE;
    v_status text;
    v_window record;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match ingress tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_seq IS NULL OR p_seq < 1 THEN
        RAISE EXCEPTION 'ingress seq must be >= 1'
            USING ERRCODE = '22023';
    END IF;

    IF p_kind NOT IN (
        'SmsReceived',
        'DeviceState',
        'CommandResult',
        'EsimInventory',
        'Alert'
    ) THEN
        RAISE EXCEPTION 'ingress kind % is not a sequenced uplink kind', p_kind
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ingress payload must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.ingress (
        device_id,
        seq,
        tenant_id,
        envelope_id,
        kind,
        payload
    ) VALUES (
        p_device_id,
        p_seq,
        p_tenant_id,
        p_envelope_id,
        p_kind,
        p_payload
    )
    ON CONFLICT (device_id, seq) DO NOTHING;

    IF FOUND THEN
        v_status := 'inserted';
    ELSE
        SELECT * INTO v_existing
          FROM app.ingress
         WHERE device_id = p_device_id
           AND seq = p_seq;

        IF v_existing.envelope_id IS DISTINCT FROM p_envelope_id
            OR v_existing.kind IS DISTINCT FROM p_kind
            OR v_existing.payload IS DISTINCT FROM p_payload THEN
            RAISE EXCEPTION 'sequence conflict for device % seq %', p_device_id, p_seq
                USING ERRCODE = '23P01';
        END IF;
        v_status := 'duplicate';
    END IF;

    SELECT w.committed_through, w.missing_ranges, w.more_missing
      INTO v_window
      FROM app.ingress_window(p_tenant_id, p_device_id) AS w;

    status := v_status;
    committed_through := v_window.committed_through;
    missing_ranges := v_window.missing_ranges;
    more_missing := v_window.more_missing;
    RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.ingress_window(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.accept_ingress(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ingress_window(uuid, uuid) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.accept_ingress(uuid, uuid, bigint, uuid, text, jsonb) TO vodoge_app;

COMMIT;
