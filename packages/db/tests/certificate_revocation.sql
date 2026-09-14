-- 吊销一张设备证书。
--
-- 🔴 M7 的整个理由是「机器丢了要收得回来」。吊销此前只能用 psql 改一列 ——
--    而一个只能靠数据库客户端执行的收回，在真出事的那天是没有人会去做的。
--    2026-09-11 认证路径才第一次开始查 revoked_at（在那之前那一列从 0006
--    起就存在、从没被读过）。
\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '77777777-aaaa-4aaa-8aaa-777777777777';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('77777777-aaaa-4aaa-8aaa-777777777777', 'revoke', 'Revoke', 'active', 'cn');

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('88888888-aaaa-4aaa-8aaa-888888888888',
        '77777777-aaaa-4aaa-8aaa-777777777777',
        '860000000000077', 'revoke-device', 'sms');

DO $$
DECLARE
    v_id      uuid;
    v_first   timestamptz;
    v_second  timestamptz;
    v_rows    integer;
BEGIN
    INSERT INTO app.device_certificates
        (tenant_id, device_id, serial, fingerprint, not_before, not_after)
    VALUES ('77777777-aaaa-4aaa-8aaa-777777777777',
            '88888888-aaaa-4aaa-8aaa-888888888888',
            'aa11', repeat('a', 64), now() - interval '1 day', now() + interval '365 days')
    RETURNING id INTO v_id;

    -- ① 刚签出来的证书没有被吊销。认证那一侧查的就是这个条件。
    SELECT count(*) INTO v_rows
      FROM app.device_certificates WHERE id = v_id AND revoked_at IS NOT NULL;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION '一张刚签出来的证书被当成了已吊销';
    END IF;

    -- ② 吊销。
    UPDATE app.device_certificates SET revoked_at = clock_timestamp()
     WHERE id = v_id AND revoked_at IS NULL;
    SELECT revoked_at INTO v_first FROM app.device_certificates WHERE id = v_id;
    IF v_first IS NULL THEN
        RAISE EXCEPTION '吊销没有写下时刻';
    END IF;

    -- ③ 🔴 再吊销一次，第一次的时刻**不许被改写**。
    --
    -- 那个时刻是「这台机器什么时候不再可信」的唯一记录，被一次重复点击
    -- 改写之后就再也答不上来了。这和 register_modem 保留首次纳管时刻是
    -- 同一条规矩（edge-store/tests/registered_modems.rs 钉着那一条）。
    --
    -- ⚠️ `AND revoked_at IS NULL` 就是那个保证。少了它，语句照样成功、
    --    返回值照样正常，只有时刻悄悄变成了今天。
    -- 🔴 用 `clock_timestamp()` 而不是 `now()`。变异验证时发现：`now()` 在
    --    同一个事务里是**固定值**，所以「少写那个 AND」的第二次 UPDATE 会写进
    --    和第一次一样的时刻 —— 断言看不出任何差别，绿得毫无意义。
    --    `clock_timestamp()` 是真实时钟，配合下面这个 pg_sleep 才能区分。
    PERFORM pg_sleep(0.01);
    UPDATE app.device_certificates SET revoked_at = clock_timestamp()
     WHERE id = v_id AND revoked_at IS NULL;
    SELECT revoked_at INTO v_second FROM app.device_certificates WHERE id = v_id;
    IF v_second IS DISTINCT FROM v_first THEN
        RAISE EXCEPTION
            '重复吊销改写了首次吊销的时刻：% → % —— 那是唯一的记录',
            v_first, v_second;
    END IF;
END
$$;
COMMIT;

-- ④ 租户隔离：别的租户看不见、也改不了这张证书。
--
-- 🔴 吊销是一个**破坏性**操作（它会把一台正在服务的机器关在门外）。跨租户
--    执行得了它，等于一个客户能停掉另一个客户的机队。
BEGIN;
SET LOCAL app.tenant_id = '66666666-aaaa-4aaa-8aaa-666666666666';
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('66666666-aaaa-4aaa-8aaa-666666666666', 'other-revoke', 'Other', 'active', 'cn');
DO $$
DECLARE
    v_rows integer;
BEGIN
    SELECT count(*) INTO v_rows FROM app.device_certificates;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION '另一个租户看见了 % 张别人的证书', v_rows;
    END IF;

    -- 看不见也就改不了 —— UPDATE 匹配不到任何行。
    UPDATE app.device_certificates SET revoked_at = now() WHERE revoked_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION '另一个租户吊销掉了别人的证书';
    END IF;
END
$$;
COMMIT;

RESET ROLE;
