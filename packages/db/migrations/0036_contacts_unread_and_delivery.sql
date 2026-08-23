-- Contacts, unread state, and network delivery receipts.
--
-- Three gaps that all end at the same two screens, so they land together
-- rather than as three migrations and three deployments of the same pair of
-- services.
--
-- 1. Delivery. app.messages could say a message was sent and never that it
--    arrived, because nothing asked: the SUBMIT PDU went out with TP-SRR
--    clear, so no network ever produced a report to store. The edge now sets
--    that bit, picks the TP-MR itself, and reports it back with the send;
--    provider_reference is where that reference is kept so a later
--    SMS-STATUS-REPORT can be matched to the one message it is about.
--
--    'sent' and 'delivered' are separate states on purpose, and so are
--    'failed' and 'undelivered'. 'failed' is the modem refusing the message.
--    'undelivered' is the network accepting it and then not being able to
--    hand it over. They arrive by different routes, minutes apart, and only
--    the second one means the recipient did not get it.
--
-- 2. Unread. There was no read state at all, so a conversation looked the
--    same whether or not anyone had opened it.
--
-- 3. Contacts. Threads were grouped by bare number, which is all the console
--    could ever show. A name is the only thing that makes a list of eleven
--    digit strings readable.
--
-- Derived from 0035's text so everything outside the kind gate and the new
-- projection branch is character-identical. app.accept_ingress stays the
-- single writer of these projections.
BEGIN;

-- What the network said about a message this device sent.
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
-- TP-MR of the submission. Nullable with no default: a message sent before
-- this migration has no reference that any report could quote, and a zero
-- would collide with the first message that legitimately uses reference 0.
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS provider_reference integer;
-- TP-ST verbatim, so a failure keeps its reason.
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS delivery_code integer;

ALTER TABLE app.messages DROP CONSTRAINT IF EXISTS messages_status_valid;
ALTER TABLE app.messages ADD CONSTRAINT messages_status_valid
    CHECK (status IN (
        'received', 'queued', 'sent', 'delivered', 'undelivered', 'failed'));

-- When the operator read an inbound message.
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Everything already in the table is marked read.
--
-- Read state is being invented here; nothing recorded it before, so there is
-- no information to lose either way. Leaving the history NULL would open the
-- console on a backlog of several hundred unread messages that is an artefact
-- of this migration rather than a fact about the mailbox, and the first thing
-- the operator would do is dismiss it -- which is this statement, run by hand.
UPDATE app.messages
   SET read_at = received_at
 WHERE direction = 'inbound'
   AND read_at IS NULL;

-- Counting unread per conversation is the inbox's main query.
CREATE INDEX IF NOT EXISTS messages_unread_idx
    ON app.messages (tenant_id, peer)
 WHERE direction = 'inbound' AND read_at IS NULL;

-- Settling a delivery receipt looks a message up by the reference the modem
-- used, and only outbound messages have one.
CREATE INDEX IF NOT EXISTS messages_provider_reference_idx
    ON app.messages (tenant_id, device_id, peer, provider_reference)
 WHERE direction = 'outbound' AND provider_reference IS NOT NULL;

-- A name for a number.
--
-- Keyed by peer rather than by an id the console has to carry around: a
-- conversation is already identified by its number everywhere else in this
-- schema, and a second identity for the same thing is how the two get out of
-- step. Deleting a thread does not delete the contact -- the name is worth
-- more than the messages and costs one row.
CREATE TABLE IF NOT EXISTS app.contacts (
    tenant_id uuid NOT NULL,
    peer text NOT NULL,
    name text NOT NULL,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, peer),
    CONSTRAINT contacts_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    CONSTRAINT contacts_peer_length CHECK (length(peer) BETWEEN 1 AND 64),
    -- A blank name is worse than no contact: the console would show an empty
    -- cell where the number used to be.
    CONSTRAINT contacts_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT contacts_name_length CHECK (length(name) <= 128),
    CONSTRAINT contacts_note_length CHECK (length(note) <= 512)
);

ALTER TABLE app.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.contacts
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.contacts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.contacts TO vodoge_app;
ALTER TABLE app.contacts OWNER TO vodoge_owner;

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
        'SmsStatusReport',
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
                    discovery, manageable, capability, last_seen_at
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

        ELSIF p_kind = 'SmsStatusReport' THEN
            -- A delivery receipt from the network. This is not the command
            -- receipt: that one moves a message from queued to sent when the
            -- modem accepts it, and is applied by the gateway against
            -- command_id. This one arrives later, out of band, and says what
            -- the network did with a message that was already sent.
            --
            -- Matched on the reference the modem used, narrowed by device and
            -- recipient. TP-MR is eight bits and wraps, so the reference alone
            -- is not unique over a long enough life; the most recent match is
            -- the only reading that can be right when it has wrapped.
            UPDATE app.messages AS m
               SET status = CASE COALESCE(p_payload ->> 'status', '')
                       WHEN 'delivered' THEN 'delivered'
                       WHEN 'failed' THEN 'undelivered'
                       -- 'pending' means the service centre is still trying.
                       -- Neither outcome has happened, and writing one would
                       -- close a message that is still in flight.
                       ELSE m.status END,
                   delivered_at = CASE
                       WHEN p_payload ->> 'status' = 'delivered'
                       THEN to_timestamp(
                           COALESCE(
                               (p_payload ->> 'delivered_at')::bigint,
                               (p_payload ->> 'reported_at')::bigint,
                               0
                           ) / 1000.0)
                       ELSE m.delivered_at END,
                   -- TP-ST verbatim, always. The four-way status throws away
                   -- the reason, and the reason is what says whether a resend
                   -- is worth trying.
                   delivery_code = COALESCE(
                       (p_payload ->> 'status_code')::integer, m.delivery_code)
             WHERE m.id = (
                     SELECT candidate.id
                       FROM app.messages AS candidate
                      WHERE candidate.tenant_id = p_tenant_id
                        AND candidate.device_id = p_device_id
                        AND candidate.direction = 'outbound'
                        AND candidate.peer = p_payload ->> 'peer'
                        AND candidate.provider_reference
                            = (p_payload ->> 'reference')::integer
                      ORDER BY candidate.created_at DESC
                      LIMIT 1);
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
