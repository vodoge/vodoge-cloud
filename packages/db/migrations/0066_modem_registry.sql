-- 纳管册子有了自己的表。
--
-- 🔴 用户当初的要求是「自动发现　手动管理　也可以取消管理……这些操作可以云端
--    直接操作　也可以边缘端操作上报云端，**数据库里是唯一依据**」。
--    那句话在云端一直不成立，原因是模型错了：
--
--      app.modems 的语义是「**被观测到的硬件**」，而纳管是一个「**决定**」。
--      决定被塞进了观测表，于是两类行各自出问题：
--        · 手工新建的模组按定义没有观测（硬件还没到）→ 进不了 modems[] →
--          app.apply_managed_modems 是纯 UPDATE、从不 INSERT → 云端没有它的行
--          → 控制台既显示不了也取消不了（2026-09-08 在生产上实测确认）；
--        · 观测到但没人管的硬件会在 app.modems 里永远躺着（生产上那两行
--          family='0' 的就是）。
--
-- 这条迁移把两件事分开：app.modem_registry 记决定，app.modems 继续记观测。
-- 控制台的列表将来是 registry LEFT JOIN 观测，于是三种状态各有位置：
-- 已纳管但从没见过 / 见过且已纳管 / 见过但没纳管。
--
-- ⚠️ 上行侧同一轮改动：DeviceStatePayload 顶层新增 `adoptions` 数组（契约
--    schema 与 Rust/Go/TS 生成物已同步）。在它之前，纳管的三样事实是塞在
--    `modems[]` 每一项里随观测走的 —— 没有观测的模组，那些事实**根本没被送出去**。
--
-- ⚠️ 函数体照旧从生产 pg_get_functiondef 原样拉下来打补丁（同 0062-0065），
--    因为 Postgres 只能整函数替换，而 0044 那次「照着挑错版本重写」已经教过一次。
BEGIN;

CREATE TABLE IF NOT EXISTS app.modem_registry (
    tenant_id     uuid        NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
    device_id     uuid        NOT NULL,
    imei          text        NOT NULL,
    -- 决定作出的时刻。不是观测时刻，也不会随轮询变。
    adopted_at    timestamptz NOT NULL,
    -- panel / cloud / migration / manual
    adopted_by    text        NOT NULL,
    -- 手工新建时由人填。没有任何观测能补出它。
    family        text,
    note          text,
    -- 纳管当时它在哪个 USB 位置。证据，不是查找键。
    usb_device    text,
    -- 最后一次和边缘对上账的时刻。用来看「这条记录还新不新」。
    reconciled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, device_id, imei),
    FOREIGN KEY (tenant_id, device_id) REFERENCES app.devices (tenant_id, id)
        ON DELETE CASCADE
);

-- 🔴 属主必须显式设成 vodoge_owner，不能靠「谁跑迁移谁拥有」。
--
--    这一行是用一次生产故障换来的。2026-09-10 03:38 这条迁移上线之后，
--    边缘上行连续 2 分 40 秒全部失败：
--
--      ERROR: permission denied for table modem_registry (SQLSTATE 42501)
--
--    原因：app.accept_ingress 是 SECURITY DEFINER、属主 vodoge_owner，而这张
--    新表归执行迁移的那个角色（生产上是 vodoge）。schema 里其它每一张表都归
--    vodoge_owner —— 因为它们是安装时手工 SET ROLE 建的，而**迁移里没有任何
--    SET ROLE**（65 个文件里 0 处）。新表不写这一行，就会和整个 schema 不一致。
--
--    ⚠️ 本地测试当时是**全绿**的：packages/db/run-tests.sh 里有一段
--    「GRANT ALL ON ALL TABLES IN SCHEMA app TO vodoge_owner」的夹具，
--    它恰好把这个缺陷盖住了 —— 那段夹具本身的注释就写着它不是修复。
--    现在 run-tests.sh 会在应用夹具**之前**先跑一次 accept_ingress，
--    这类错误不会再静静通过。
ALTER TABLE app.modem_registry OWNER TO vodoge_owner;

ALTER TABLE app.modem_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.modem_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON app.modem_registry;
CREATE POLICY tenant_isolation ON app.modem_registry
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.modem_registry FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.modem_registry TO vodoge_app;

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

            -- 纳管册子。**决定**，不是观测 —— 所以它自己一段，不跟着 modems 走。
            --
            -- 🔴 `? 'adoptions'` 这个判断是整段的要害：边缘读不到注册表时**不发
            --    这个键**，而不是发一个空数组。把「没说」当成「一根都没有」，
            --    就是 managed_imeis 那次事故的形状 —— 一次短暂的存储读失败
            --    取消了整台设备的纳管。
            IF p_payload ? 'adoptions' THEN
                -- ⚠️ 防回放。补洞重传会把**旧 seq 的信**插在新信之后（那是上行
                --    协议设计出来就要走的路），而这一段带 DELETE，是破坏性的。
                --    比 seq 不比 observed_at：seq 是设备侧持久单调计数器发的，
                --    observed_at 是设备墙钟、会跳。
                --
                --    挂在 app.ingress 上的 project_managed_modems /
                --    project_modem_candidates 至今没有这道闸（退役模组会复活、
                --    刚插上的候选会被旧清单删掉）。新表不继承那个洞。
                IF NOT EXISTS (
                    SELECT 1 FROM app.ingress AS newer
                     WHERE newer.device_id = p_device_id
                       AND newer.kind = 'DeviceState'
                       AND newer.seq > p_seq
                ) THEN
                    FOR v_modem IN
                        SELECT * FROM jsonb_array_elements(p_payload -> 'adoptions')
                    LOOP
                        INSERT INTO app.modem_registry (
                            tenant_id, device_id, imei,
                            adopted_at, adopted_by, family, note, usb_device
                        ) VALUES (
                            p_tenant_id,
                            p_device_id,
                            v_modem ->> 'modem_imei',
                            to_timestamp(
                                COALESCE((v_modem ->> 'adopted_at')::bigint, 0) / 1000.0),
                            COALESCE(NULLIF(v_modem ->> 'adopted_by', ''), 'unknown'),
                            NULLIF(v_modem ->> 'family', ''),
                            NULLIF(v_modem ->> 'adoption_note', ''),
                            NULLIF(v_modem ->> 'usb_device', '')
                        )
                        ON CONFLICT (tenant_id, device_id, imei) DO UPDATE SET
                            -- 决定本身只有人改它才会变，所以照搬；但读不到的
                            -- 不覆盖已记下的（同 0062 那条卡侧字段的纪律）。
                            adopted_at = EXCLUDED.adopted_at,
                            adopted_by = EXCLUDED.adopted_by,
                            family = COALESCE(EXCLUDED.family, app.modem_registry.family),
                            note = EXCLUDED.note,
                            usb_device = COALESCE(
                                EXCLUDED.usb_device, app.modem_registry.usb_device),
                            reconciled_at = now();
                    END LOOP;

                    -- 取消纳管：册子上没有的，行就该消失。这是 D 在云端唯一的
                    -- 到达方式 —— 边缘删了自己的行，只能靠「下一封信里它不在了」
                    -- 说出来。
                    DELETE FROM app.modem_registry AS r
                     WHERE r.tenant_id = p_tenant_id
                       AND r.device_id = p_device_id
                       AND NOT EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(p_payload -> 'adoptions') AS a
                            WHERE a ->> 'modem_imei' = r.imei
                       );
                END IF;
            END IF;

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
