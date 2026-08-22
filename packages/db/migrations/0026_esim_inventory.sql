BEGIN;

-- EsimInventory has been an accepted message kind since the beginning and
-- nothing ever projected it, so a device's eUICC contents landed in the
-- journal as raw envelopes that nothing read.
--
-- The eUICC is identified by EID, which is burnt into the chip and does not
-- change. ICCIDs on it do change — that is the point of an eUICC — so the
-- inventory is keyed by (eid, iccid) and the modem's IMEI is carried as an
-- observation rather than as identity: the same chip can be read from a
-- different modem after a swap.
CREATE TABLE app.esim_profiles (
    tenant_id uuid NOT NULL,
    eid text NOT NULL,
    iccid text NOT NULL,
    state text NOT NULL,
    nickname text,
    -- Which modem last reported this chip, and when.
    modem_imei text,
    device_id uuid,
    collected_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, eid, iccid),
    CONSTRAINT esim_profiles_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    CONSTRAINT esim_profiles_eid_shape CHECK (eid ~ '^[0-9]{32}$'),
    CONSTRAINT esim_profiles_iccid_shape CHECK (iccid ~ '^[0-9]{19,20}$'),
    CONSTRAINT esim_profiles_state_known
        CHECK (state IN ('enabled', 'disabled', 'deleted', 'unknown'))
);

CREATE INDEX esim_profiles_tenant_modem_idx
    ON app.esim_profiles (tenant_id, modem_imei);

ALTER TABLE app.esim_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.esim_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.esim_profiles
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.esim_profiles FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.esim_profiles TO vodoge_app;
ALTER TABLE app.esim_profiles OWNER TO vodoge_owner;

CREATE OR REPLACE FUNCTION app.project_esim_inventory(
    p_tenant_id uuid,
    p_device_id uuid,
    p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_eid text;
    v_imei text;
    v_at timestamptz;
    v_profile jsonb;
BEGIN
    v_eid := p_payload ->> 'eid';
    v_imei := p_payload ->> 'modem_imei';
    v_at := to_timestamp(COALESCE((p_payload ->> 'collected_at')::bigint, 0) / 1000.0);

    IF COALESCE(v_eid, '') = '' THEN
        RETURN;
    END IF;

    -- An inventory is the complete contents of one chip, so a profile that has
    -- disappeared from it has been deleted from the chip. Marking rather than
    -- removing: which ICCID used to be on a card is worth keeping, and a row
    -- that vanishes takes the only record of it with it.
    UPDATE app.esim_profiles
       SET state = 'deleted', collected_at = v_at
     WHERE tenant_id = p_tenant_id
       AND eid = v_eid
       AND collected_at < v_at
       AND iccid NOT IN (
           SELECT value ->> 'iccid'
             FROM jsonb_array_elements(COALESCE(p_payload -> 'profiles', '[]'::jsonb))
            WHERE COALESCE(value ->> 'iccid', '') <> ''
       );

    FOR v_profile IN
        SELECT value FROM jsonb_array_elements(COALESCE(p_payload -> 'profiles', '[]'::jsonb))
    LOOP
        CONTINUE WHEN COALESCE(v_profile ->> 'iccid', '') = '';

        INSERT INTO app.esim_profiles
            (tenant_id, eid, iccid, state, nickname, modem_imei, device_id, collected_at)
        VALUES (
            p_tenant_id, v_eid,
            v_profile ->> 'iccid',
            COALESCE(v_profile ->> 'state', 'unknown'),
            NULLIF(v_profile ->> 'nickname', ''),
            v_imei, p_device_id, v_at
        )
        ON CONFLICT (tenant_id, eid, iccid) DO UPDATE SET
            state = EXCLUDED.state,
            nickname = COALESCE(EXCLUDED.nickname, app.esim_profiles.nickname),
            modem_imei = EXCLUDED.modem_imei,
            device_id = EXCLUDED.device_id,
            collected_at = EXCLUDED.collected_at
        -- An inventory that arrives out of order after a reconnect must not
        -- overwrite a newer one.
        WHERE EXCLUDED.collected_at >= app.esim_profiles.collected_at;
    END LOOP;
END
$$;

ALTER FUNCTION app.project_esim_inventory(uuid, uuid, jsonb) OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.project_esim_inventory(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_esim_inventory(uuid, uuid, jsonb) TO vodoge_app;

INSERT INTO app.schema_migrations (version, name) VALUES (26, '0026_esim_inventory')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- accept_ingress gains the EsimInventory branch. Derived from 0019's text so
-- everything outside that branch is character-identical.
BEGIN;

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
    v_modem jsonb;
    v_observed timestamptz;
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

    -- Project only what was newly accepted. Replaying a duplicate must not
    -- move a device's liveness or overwrite fresher modem state with an older
    -- observation the edge happens to be resending.
    IF v_status = 'inserted' THEN
        IF p_kind = 'DeviceState' THEN
            v_observed := to_timestamp(
                COALESCE((p_payload ->> 'observed_at')::bigint, 0) / 1000.0
            );

            UPDATE app.devices
               SET last_seen_at = GREATEST(COALESCE(last_seen_at, v_observed), v_observed),
                   state = p_payload,
                   updated_at = now()
             WHERE tenant_id = p_tenant_id
               AND id = p_device_id;

            FOR v_modem IN
                SELECT value FROM jsonb_array_elements(
                    COALESCE(p_payload -> 'modems', '[]'::jsonb)
                )
            LOOP
                CONTINUE WHEN COALESCE(v_modem ->> 'modem_imei', '') = '';

                INSERT INTO app.modems (
                    tenant_id, device_id, imei, family, iccid, imsi,
                    home_plmn, serving_plmn,
                    state, registration, signal_dbm, capability, last_seen_at
                ) VALUES (
                    p_tenant_id,
                    p_device_id,
                    v_modem ->> 'modem_imei',
                    COALESCE(v_modem ->> 'family', 'unknown'),
                    NULLIF(v_modem ->> 'iccid', ''),
                    NULLIF(v_modem ->> 'imsi', ''),
                    NULLIF(v_modem ->> 'home_plmn', ''),
                    NULLIF(v_modem ->> 'serving_plmn', ''),
                    v_modem ->> 'state',
                    v_modem ->> 'registration',
                    (v_modem ->> 'signal_dbm')::integer,
                    COALESCE(v_modem -> 'capability', '{}'::jsonb),
                    v_observed
                )
                ON CONFLICT (tenant_id, device_id, imei) DO UPDATE SET
                    -- ICCID is left alone when absent rather than cleared: an
                    -- observation that could not read the card must not erase
                    -- the last one that could.
                    iccid = COALESCE(EXCLUDED.iccid, app.modems.iccid),
                    -- Card identity, same policy as ICCID: a read that failed
                    -- this round must not erase the last one that worked.
                    imsi = COALESCE(EXCLUDED.imsi, app.modems.imsi),
                    home_plmn = COALESCE(EXCLUDED.home_plmn, app.modems.home_plmn),
                    -- Live status, opposite policy: where the card is
                    -- registered right now follows the observation, and NULL
                    -- means the serving system genuinely was not readable —
                    -- keeping a stale network would claim a registration the
                    -- modem no longer has.
                    serving_plmn = EXCLUDED.serving_plmn,
                    family = EXCLUDED.family,
                    state = EXCLUDED.state,
                    registration = EXCLUDED.registration,
                    signal_dbm = EXCLUDED.signal_dbm,
                    capability = EXCLUDED.capability,
                    last_seen_at = GREATEST(
                        COALESCE(app.modems.last_seen_at, EXCLUDED.last_seen_at),
                        EXCLUDED.last_seen_at
                    ),
                    updated_at = now()
                -- Out-of-order replay is possible after a reconnect, so an
                -- older observation is dropped rather than applied.
                WHERE EXCLUDED.last_seen_at >= COALESCE(app.modems.last_seen_at, EXCLUDED.last_seen_at);
            END LOOP;

        ELSIF p_kind = 'EsimInventory' THEN
            PERFORM app.project_esim_inventory(p_tenant_id, p_device_id, p_payload);

        ELSIF p_kind = 'ProxyTraffic' THEN
            PERFORM app.project_proxy_traffic(p_tenant_id, p_payload);

        ELSIF p_kind = 'SmsReceived' THEN
            INSERT INTO app.messages (
                tenant_id, device_id, modem_id, direction,
                peer, body, bearer, received_at, seq, dedupe_key
            ) VALUES (
                p_tenant_id,
                p_device_id,
                (SELECT m.id FROM app.modems AS m
                  WHERE m.tenant_id = p_tenant_id
                    AND m.device_id = p_device_id
                    AND m.imei = p_payload ->> 'modem_imei'),
                'inbound',
                COALESCE(p_payload ->> 'peer', ''),
                COALESCE(p_payload ->> 'body', ''),
                COALESCE(NULLIF(p_payload ->> 'bearer', ''), 'unknown'),
                to_timestamp(COALESCE((p_payload ->> 'received_at')::bigint, 0) / 1000.0),
                p_seq,
                p_envelope_id::text
            )
            -- The uplink sequence already makes this idempotent; the guard is
            -- here so a projection replay can never raise instead of resolving.
            ON CONFLICT (device_id, seq) DO NOTHING;
        END IF;
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

ALTER FUNCTION app.accept_ingress(uuid, uuid, bigint, uuid, text, jsonb) OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.accept_ingress(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_ingress(uuid, uuid, bigint, uuid, text, jsonb) TO vodoge_app;

COMMIT;
