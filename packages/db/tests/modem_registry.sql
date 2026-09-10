-- 纳管册子：一个**决定**的记录，不是一次观测。
--
-- 🔴 这张表存在的理由，是用户当初那句「数据库里是唯一依据」在云端不成立。
--
--    纳管的三样事实（谁、什么时候、为什么）以前塞在 `modems[]` 每一项里随观测
--    上行，而 app.modems 只装**被观测到的硬件**。手工新建的模组按定义没有观测
--    （硬件还没到），于是：
--      · 它进不了 modems[]，云端只从 managed_imeis 收到一个裸 IMEI；
--      · app.apply_managed_modems 是纯 UPDATE、从不 INSERT，所以 app.modems
--        里没有它的行；
--      · 控制台读 app.modems WHERE managed，于是**既显示不了它，也取消不了它**。
--
--    2026-09-08 在生产上实测过：边缘手工建一根，云端 app.modems 里查不到。
--
-- 这张表把「决定」和「观测」分开，两边各自说自己那一半的话。
\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '66666666-6666-6666-6666-666666666666';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('66666666-6666-6666-6666-666666666666', 'modem-registry',
        'Modem Registry', 'active', 'cn');

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '66666666-6666-6666-6666-666666666666',
        '860000000000006', 'registry-device', 'sms');

DO $$
DECLARE
    v_status text;
    v_by text;
    v_note text;
    v_family text;
    v_rows integer;
BEGIN
    -- ① 一根**从没被观测过**的模组，纳管记录必须照样落库。
    --    这正是旧模型丢掉的那一类：payload 里 modems 是空的。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '66666666-6666-6666-6666-666666666666',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          10,
          '10000000-2000-3000-4000-500000000001',
          'DeviceState',
          jsonb_build_object(
              'observed_at', 1788000000000::bigint,
              'modems', '[]'::jsonb,
              'managed_imeis', jsonb_build_array('860000000000042'),
              'adoptions', jsonb_build_array(jsonb_build_object(
                  'modem_imei', '860000000000042',
                  'adopted_at', 1700000000000::bigint,
                  'adopted_by', 'manual',
                  'family', 'EC20',
                  'adoption_note', '先建后到货'
              ))
          )
      ) AS a;
    IF v_status <> 'inserted' THEN
        RAISE EXCEPTION 'device state was not accepted: %', v_status;
    END IF;

    SELECT r.adopted_by, r.note, r.family INTO v_by, v_note, v_family
      FROM app.modem_registry AS r WHERE r.imei = '860000000000042';
    IF v_by IS NULL THEN
        RAISE EXCEPTION '一根没被观测过的模组，纳管记录没有落库 —— 这正是这张表要修的那件事';
    END IF;
    -- ⚠️ IS DISTINCT FROM，不是 <>：v_by 为 NULL 时 `NULL <> 'manual'` 求值为
    --    NULL，IF 根本不触发，于是「字段没落库」这种失败会**静静地通过**。
    IF v_by IS DISTINCT FROM 'manual' THEN
        RAISE EXCEPTION 'adopted_by 不对: %', v_by;
    END IF;
    IF v_note IS DISTINCT FROM '先建后到货' THEN
        RAISE EXCEPTION '备注丢了: %', v_note;
    END IF;
    -- 型号是人填的，没有任何观测能补出它。
    IF v_family IS DISTINCT FROM 'EC20' THEN
        RAISE EXCEPTION '人填的型号丢了: %', v_family;
    END IF;

    -- ② 取消纳管：下一封信里它不在册子上了，行就该消失。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '66666666-6666-6666-6666-666666666666',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          11,
          '10000000-2000-3000-4000-500000000002',
          'DeviceState',
          jsonb_build_object(
              'observed_at', 1788000001000::bigint,
              'modems', '[]'::jsonb,
              'managed_imeis', '[]'::jsonb,
              'adoptions', '[]'::jsonb
          )
      ) AS a;

    SELECT count(*) INTO v_rows FROM app.modem_registry;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION '取消纳管之后册子上还剩 % 行', v_rows;
    END IF;

    -- ③ 读不到注册表时，边缘**不发这个键**。这时候一行都不许动。
    --    把「没说」当成「一根都没有」，就是 managed_imeis 那次事故的形状：
    --    一次短暂的存储读失败取消了整台设备的纳管。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '66666666-6666-6666-6666-666666666666',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          12,
          '10000000-2000-3000-4000-500000000003',
          'DeviceState',
          jsonb_build_object(
              'observed_at', 1788000002000::bigint,
              'modems', '[]'::jsonb,
              'managed_imeis', jsonb_build_array('860000000000042'),
              'adoptions', jsonb_build_array(jsonb_build_object(
                  'modem_imei', '860000000000042',
                  'adopted_at', 1700000000000::bigint,
                  'adopted_by', 'manual'
              ))
          )
      ) AS a;
    SELECT count(*) INTO v_rows FROM app.modem_registry;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION '先建一行没成功，后面那条断言就没意义了';
    END IF;

    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '66666666-6666-6666-6666-666666666666',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          13,
          '10000000-2000-3000-4000-500000000004',
          'DeviceState',
          -- 注意：**没有** adoptions 这个键。
          jsonb_build_object(
              'observed_at', 1788000003000::bigint,
              'modems', '[]'::jsonb
          )
      ) AS a;
    SELECT count(*) INTO v_rows FROM app.modem_registry;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION '边缘没说话，云端却把册子清了 —— 缺席被当成了空';
    END IF;

    -- ④ 防回放：补洞重传会把**旧 seq 的信**插在新信之后。
    --    一封更旧的信不许改写册子。这是 project_managed_modems 至今仍有的洞，
    --    新表不该继承它。
    SELECT a.status INTO v_status
      FROM app.accept_ingress(
          '66666666-6666-6666-6666-666666666666',
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          -- 比上面那几封都旧，但仍是合法序号（accept_ingress 要求 >= 1）。
          -- 补洞重传送上来的就是这种：旧 seq、晚到达。
          5,
          '10000000-2000-3000-4000-500000000000',
          'DeviceState',
          jsonb_build_object(
              'observed_at', 1787000000000::bigint,
              'modems', '[]'::jsonb,
              'managed_imeis', '[]'::jsonb,
              'adoptions', '[]'::jsonb
          )
      ) AS a;
    SELECT count(*) INTO v_rows FROM app.modem_registry;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION '一封旧信把册子清掉了 —— 补洞重传每次重连都会这么干';
    END IF;
END
$$;
COMMIT;

-- ⑤ 属主必须是 vodoge_owner。
--
-- 🔴 这一条是用一次生产故障换来的。2026-09-10 03:38 这条迁移上线之后，
--    边缘上行连续 2 分 40 秒全部 `permission denied for table modem_registry
--    (SQLSTATE 42501)`：accept_ingress 是 SECURITY DEFINER、属主 vodoge_owner，
--    而这张新表当时归执行迁移的角色。
--
-- ⚠️ 而当时本地 12 个测试**全绿** —— run-tests.sh 里那段
--    「GRANT ALL ON ALL TABLES IN SCHEMA app TO vodoge_owner」的夹具把它盖住了。
--    所以这条断言刻意**不去测权限**（夹具会让权限永远够），而是直接测属主：
--    夹具改不了属主，这条就盖不住。
DO $$
DECLARE
    v_table_owner text;
    v_func_owner text;
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_table_owner
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relname = 'modem_registry';

    SELECT pg_get_userbyid(p.proowner) INTO v_func_owner
      FROM pg_proc AS p
     WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'accept_ingress';

    IF v_table_owner IS DISTINCT FROM v_func_owner THEN
        RAISE EXCEPTION
            'app.modem_registry 归 %，而写它的 accept_ingress 归 % —— '
            'SECURITY DEFINER 那条链会在生产上 42501（2026-09-10 已经发生过一次）',
            v_table_owner, v_func_owner;
    END IF;
END
$$;

RESET ROLE;
