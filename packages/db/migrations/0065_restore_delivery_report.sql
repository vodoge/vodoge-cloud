-- 把投递回执那条路接回来，并说清它是怎么断的。
--
-- 🔴 这是一次**静默回退**，不是漏写。0036 给 app.accept_ingress 加了
--    'SmsStatusReport' 的白名单项和投影分支。0044 的头注释写着
--    「Derived from 0035's text so everything outside the changed projection
--    block is character-identical」—— 而 0035 在 0036 **之前**。
--    那次 CREATE OR REPLACE 把 0036 加的东西整个盖掉了，此后
--    0047 / 0060 / 0062 / 0063 / 0064 全部继承了这份缺失的函数体。
--
--    ⚠️ Postgres 只能整函数替换，所以「照上一版的文本改一处」是这个仓库重写
--    accept_ingress 的常规做法 —— 这次事故说明：**照的必须是当前生效的那一
--    版**，不是随手挑的某一版。本文件的函数体同样是从生产的
--    pg_get_functiondef 原样拉下来打的补丁。
--
-- 后果（2026-09-08 在生产上查证）：边缘每 8 秒仍在读 SR 存储、解码、删除、
-- 上行，网关也把它算作合法 kind，只有数据库拒收。于是从 0044 应用的那一刻
-- （2026-08-28 16:41）起，每一条回执被写成 Unstorable 墓碑、ack 掉、
-- **永久丢失** —— 墓碑只留 reason / original_kind，不留 payload，所以已经
-- 丢掉的 18 条找不回来了。app.messages.delivered_at 在这 11 天里没有写入者。
--
-- 而 modem_left_bus_after_submit 这个「失败但对端可能真收到了」的分支，
-- 给运维的指引正是「重发之前先查投递回执」。
--
-- ProxyTraffic 是同一处回退的另一半：函数体里 ELSIF 分支还在，白名单里没有。
-- 生产上一条都没有，只因为代理还没被用过 —— 用起来的那天，每一封都会走同样
-- 的墓碑路。一并加回。
--
-- ⚠️ 这个洞能躺 11 天，根因是 packages/db/tests 下的十个测试**从来没有人跑过**：
--    CI 里没有任何一步执行它们。本次同时补上 tests/delivery_report.sql 和
--    跑它们的那一步 —— 没有那一步，这条迁移明天就能被同样的方式再抹一次。
BEGIN;

CREATE OR REPLACE FUNCTION app.accept_ingress(p_tenant_id uuid, p_device_id uuid, p_seq bigint, p_envelope_id uuid, p_kind text, p_payload jsonb)
 RETURNS TABLE(status text, committed_through bigint, missing_ranges jsonb, more_missing boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
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
        'ProxyTraffic',
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
                    firmware, msisdn, msisdn_iccid, control_port, usb_device, apn_contexts,
                    adoption_note, adopted_at, adopted_by
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
                    -- 老 agent 的 payload 里没有这一项，于是是 NULL —— 那正好是
                    -- 「不知道号码是从哪张卡读的」，控制台会据此闭嘴而不是乱说。
                    NULLIF(v_modem ->> 'msisdn_iccid', ''),
                    NULLIF(v_modem ->> 'control_port', ''),
                    NULLIF(v_modem ->> 'usb_device', ''),
                    -- Left NULL rather than defaulted to an empty array: an
                    -- agent that does not read them and a module that holds
                    -- none are different facts, and the second is the one that
                    -- explains a stick with no data connection.
                    CASE WHEN jsonb_typeof(v_modem -> 'apn_contexts') = 'array'
                         THEN v_modem -> 'apn_contexts' END,
                         -- 纳管记录随观测一起来。
                         NULLIF(v_modem ->> 'adoption_note', ''),
                         CASE WHEN (v_modem ->> 'adopted_at') IS NOT NULL
                              THEN to_timestamp((v_modem ->> 'adopted_at')::bigint / 1000.0) END,
                         NULLIF(v_modem ->> 'adopted_by', '')
                )
                ON CONFLICT (tenant_id, device_id, imei) DO UPDATE SET
                    -- ICCID is left alone when absent rather than cleared: an
                    -- observation that could not read the card must not erase
                    -- the last one that could.
                    -- 纳管记录：和 ICCID 同一条规则。这一轮读不到注册表时上行的是
                    -- NULL，那是「没读到」不是「没有备注」，覆盖会把人写下的理由
                    -- 悄悄抹掉。清空备注走 update_modem，那条命令的语义是明确的。
                    adoption_note = COALESCE(EXCLUDED.adoption_note, app.modems.adoption_note),
                    adopted_at = COALESCE(EXCLUDED.adopted_at, app.modems.adopted_at),
                    adopted_by = COALESCE(EXCLUDED.adopted_by, app.modems.adopted_by),
                    iccid = COALESCE(EXCLUDED.iccid, app.modems.iccid),
                    -- Card identity, same policy as ICCID: a read that failed
                    -- this round must not erase the last one that worked.
                    -- 🔴 卡侧字段：**卡没换才继承**。
                    --
                    -- 边缘那侧 0011 就把理由写下来了 ——「没有它，一个号码会活得
                    -- 比它的卡还久、被显示在下一张卡名下，那比什么都不显示更坏，
                    -- 因为它是一个看起来合理的错答案」。云端这一半一直是无条件
                    -- COALESCE：换卡之后新卡的号一时读不出来，控制台就长期挂着
                    -- 上一张卡的号，而运维正是靠这个字段认卡的。
                    --
                    -- 判据用云端自己就有的 iccid，不需要新的契约字段：拿旧值和
                    -- 这一轮的**有效值**比（EXCLUDED 为空时有效值就是旧值，所以
                    -- 一次读失败不会被误判成换卡）。
                    --
                    -- IS NOT DISTINCT FROM 是空安全的：一根还没读出卡号的模组
                    -- 两边都是 NULL，用 = 会判成不等，于是每一轮都把刚读到的
                    -- 东西擦掉。
                    imsi = CASE
                        WHEN EXCLUDED.imsi IS NOT NULL THEN EXCLUDED.imsi
                        WHEN app.modems.iccid IS NOT DISTINCT FROM
                             COALESCE(EXCLUDED.iccid, app.modems.iccid)
                            THEN app.modems.imsi
                        ELSE NULL
                    END,
                    home_plmn = CASE
                        WHEN EXCLUDED.home_plmn IS NOT NULL THEN EXCLUDED.home_plmn
                        WHEN app.modems.iccid IS NOT DISTINCT FROM
                             COALESCE(EXCLUDED.iccid, app.modems.iccid)
                            THEN app.modems.home_plmn
                        ELSE NULL
                    END,
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
                    msisdn = CASE
                        WHEN EXCLUDED.msisdn IS NOT NULL THEN EXCLUDED.msisdn
                        WHEN app.modems.iccid IS NOT DISTINCT FROM
                             COALESCE(EXCLUDED.iccid, app.modems.iccid)
                            THEN app.modems.msisdn
                        ELSE NULL
                    END,
                    -- 号码是从哪张卡读的。它本身也是卡侧字段 —— 跟着号码一起
                    -- 作废，否则会出现「号码没了、指针还指着当前卡」的组合，
                    -- 而那个组合读起来是「问过了，这张卡没号码」，正好说反。
                    msisdn_iccid = CASE
                        WHEN EXCLUDED.msisdn_iccid IS NOT NULL THEN EXCLUDED.msisdn_iccid
                        WHEN app.modems.iccid IS NOT DISTINCT FROM
                             COALESCE(EXCLUDED.iccid, app.modems.iccid)
                            THEN app.modems.msisdn_iccid
                        ELSE NULL
                    END,
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

        ELSIF p_kind = 'SmsReceived' THEN
            INSERT INTO app.messages (
                tenant_id, device_id, modem_id, iccid, direction, status,
                peer, body, bearer, encoding, received_at, seq, dedupe_key
            ) VALUES (
                p_tenant_id,
                p_device_id,
                (SELECT m.id FROM app.modems AS m
                  WHERE m.tenant_id = p_tenant_id
                    AND m.device_id = p_device_id
                    AND m.imei = p_payload ->> 'modem_imei'),
                -- 收下这条消息的那张卡，由边缘在收下的**那一刻**记下。
                --
                -- 🔴 不能改成从 app.modems 现查：那查到的是「这根棒现在插的卡」，
                --    而这条消息可能是上一张卡收的。换卡之后现查会把整段历史重新
                --    上色，而那正是这一列存在要防的事。
                --
                -- ⚠️ NULLIF 把老 agent 送来的空串收敛成 NULL。空串读起来像
                --    「这条没有卡」，而它其实是「那时候还没记」。
                NULLIF(p_payload ->> 'iccid', ''),
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
$function$;

COMMIT;
