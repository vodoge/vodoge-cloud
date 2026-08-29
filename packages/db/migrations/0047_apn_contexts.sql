-- The packet data profiles each module is carrying.
--
-- Which context carries data is a row in a table on the module, not a property
-- of the card or the network, and until now the only way to see that table was
-- to type `AT+CGDCONT?` into the console and read the answer by hand. An
-- operator diagnosing a stick with no data connection is asking exactly this.
--
-- jsonb rather than a child table because nothing queries inside it: it is
-- displayed as a block and replaced as a block, and a join would buy a
-- migration and no answers.
--
-- NULL is "the agent has not read them", which is a different fact from a
-- module holding none -- that is an empty array. The difference matters
-- precisely when somebody is looking at a stick that will not carry data.
BEGIN;

ALTER TABLE app.modems ADD COLUMN IF NOT EXISTS apn_contexts jsonb;

ALTER TABLE app.modems DROP CONSTRAINT IF EXISTS modems_apn_contexts_is_array;
ALTER TABLE app.modems ADD CONSTRAINT modems_apn_contexts_is_array
    CHECK (apn_contexts IS NULL OR jsonb_typeof(apn_contexts) = 'array');

COMMENT ON COLUMN app.modems.apn_contexts IS
    'Packet data profiles as AT+CGDCONT? reports them. NULL means unread; an empty array means the module held none.';

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
                   -- Host vitals follow the observation, including into
                   -- NULL: an agent that could not read its own memory this
                   -- pass must not leave the last figure standing as if it
                   -- were current. The whole block is skipped when the
                   -- payload carries no `host` at all, which is what an
                   -- agent older than this migration sends.
                   public_ip = CASE WHEN p_payload ? 'host'
                       THEN NULLIF(p_payload -> 'host' ->> 'public_ip', '')
                       ELSE public_ip END,
                   cpu_percent = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'cpu_percent')::numeric
                       ELSE cpu_percent END,
                   memory_used_bytes = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'memory_used_bytes')::bigint
                       ELSE memory_used_bytes END,
                   memory_total_bytes = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'memory_total_bytes')::bigint
                       ELSE memory_total_bytes END,
                   -- Same policy for the readings added here: present in the
                   -- host block or gone, never a stale figure kept because
                   -- this pass could not take one.
                   disk_used_bytes = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'disk_used_bytes')::bigint
                       ELSE disk_used_bytes END,
                   disk_total_bytes = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'disk_total_bytes')::bigint
                       ELSE disk_total_bytes END,
                   net_rx_bytes_per_sec = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'net_rx_bytes_per_sec')::bigint
                       ELSE net_rx_bytes_per_sec END,
                   net_tx_bytes_per_sec = CASE WHEN p_payload ? 'host'
                       THEN (p_payload -> 'host' ->> 'net_tx_bytes_per_sec')::bigint
                       ELSE net_tx_bytes_per_sec END,
                   -- Hardware identity is static for the life of a machine,
                   -- but it still follows the block rather than being kept:
                   -- an agent that stopped reporting it has been replaced by
                   -- one that cannot, and showing the old box's CPU would be
                   -- a claim about hardware nobody is looking at.
                   cpu_model = CASE WHEN p_payload ? 'host'
                       THEN NULLIF(p_payload -> 'host' ->> 'cpu_model', '')
                       ELSE cpu_model END,
                   kernel = CASE WHEN p_payload ? 'host'
                       THEN NULLIF(p_payload -> 'host' ->> 'kernel', '')
                       ELSE kernel END,
                   hostname = CASE WHEN p_payload ? 'host'
                       THEN NULLIF(p_payload -> 'host' ->> 'hostname', '')
                       ELSE hostname END,
                   host_reported_at = CASE WHEN p_payload ? 'host'
                       THEN v_observed ELSE host_reported_at END,
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
                    state, registration, signal_dbm, rsrp, rsrq, sinr,
                    discovery, manageable, capability, last_seen_at,
                    firmware, msisdn, control_port, usb_device, apn_contexts
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
                    (v_modem ->> 'rsrp')::integer,
                    (v_modem ->> 'rsrq')::integer,
                    (v_modem ->> 'sinr')::integer,
                    -- Absent from an older agent's payload, and left NULL rather
                    -- than guessed as 'qmi': the whole point of the column is to
                    -- say which modules the agent could not drive.
                    v_modem ->> 'discovery',
                    (v_modem ->> 'manageable')::boolean,
                    COALESCE(v_modem -> 'capability', '{}'::jsonb),
                    v_observed,
                    NULLIF(v_modem ->> 'firmware', ''),
                    NULLIF(v_modem ->> 'msisdn', ''),
                    NULLIF(v_modem ->> 'control_port', ''),
                    NULLIF(v_modem ->> 'usb_device', ''),
                    -- Left NULL rather than defaulted to an empty array: an
                    -- agent that does not read them and a module that holds
                    -- none are different facts, and the second is the one that
                    -- explains a stick with no data connection.
                    CASE WHEN jsonb_typeof(v_modem -> 'apn_contexts') = 'array'
                         THEN v_modem -> 'apn_contexts' END
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
                    -- Live readings, same policy as signal_dbm: a pass that could
                    -- not measure reports NULL, and keeping the last good figure
                    -- would show a dead radio as a healthy one.
                    rsrp = EXCLUDED.rsrp,
                    rsrq = EXCLUDED.rsrq,
                    sinr = EXCLUDED.sinr,
                    -- How the module was found this pass. One that has dropped out
                    -- of QMI must not keep claiming it is manageable because it
                    -- was an hour ago.
                    discovery = EXCLUDED.discovery,
                    manageable = EXCLUDED.manageable,
                    capability = EXCLUDED.capability,
                    -- Identity, kept when a pass could not read it: the
                    -- firmware on a stick does not stop existing because one
                    -- probe was answered by a module that had just restarted,
                    -- and a number belongs to the card rather than the poll.
                    firmware = COALESCE(EXCLUDED.firmware, app.modems.firmware),
                    msisdn = COALESCE(EXCLUDED.msisdn, app.modems.msisdn),
                    -- Topology, replaced rather than kept: a control port that
                    -- has moved is exactly what an operator needs to see, and
                    -- the stale one would send them to a node that is now
                    -- somebody else's.
                    control_port = EXCLUDED.control_port,
                    usb_device = EXCLUDED.usb_device,
                    -- Kept when a pass could not read them, like the identity
                    -- above: the module's profile table does not stop existing
                    -- because one AT round trip was lost.
                    apn_contexts = COALESCE(EXCLUDED.apn_contexts, app.modems.apn_contexts),
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
                tenant_id, device_id, modem_id, direction, status,
                peer, body, bearer, encoding, received_at, seq, dedupe_key
            ) VALUES (
                p_tenant_id,
                p_device_id,
                (SELECT m.id FROM app.modems AS m
                  WHERE m.tenant_id = p_tenant_id
                    AND m.device_id = p_device_id
                    AND m.imei = p_payload ->> 'modem_imei'),
                'inbound',
                -- messages.status is NOT NULL with no default, and
                -- messages_status_valid admits received/queued/sent/failed.
                -- Inbound skips the send lifecycle entirely: by the time the
                -- modem hands it over it has already arrived.
                'received',
                COALESCE(p_payload ->> 'peer', ''),
                COALESCE(p_payload ->> 'body', ''),
                COALESCE(NULLIF(p_payload ->> 'bearer', ''), 'unknown'),
                -- Which alphabet the message arrived in. It matters to a
                -- reader: an '8bit' body is hex because the message was binary
                -- OTA traffic, not because the decoder failed.
                COALESCE(NULLIF(p_payload ->> 'encoding', ''), 'unknown'),
                to_timestamp(COALESCE((p_payload ->> 'received_at')::bigint, 0) / 1000.0),
                p_seq,
                p_envelope_id::text
            )
            -- The uplink sequence already makes this idempotent; the guard is
            -- here so a projection replay can never raise instead of resolving.
            -- The index this targets became partial in 0021, when outbound
            -- messages arrived: they carry no journal sequence, so two sends
            -- would have collided on seq 0. A partial index only satisfies an
            -- ON CONFLICT that repeats its predicate, and without it PostgreSQL
            -- raises 42P10 — which ends the device's session. The first real
            -- inbound SMS hit this and put the uplink into a crash loop.
            ON CONFLICT (device_id, seq) WHERE direction = 'inbound' DO NOTHING;
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
