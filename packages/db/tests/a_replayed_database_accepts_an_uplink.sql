-- 照迁移重放出来的库，收得下一封设备上行吗。
--
-- 🔴 在 0071 之前，答案是**收不下**。实测（把全部迁移重放到空库，再以
--    vodoge_gateway 身份调用，不打任何补丁）：
--
--      ERROR:  permission denied for schema app
--      CONTEXT:  compilation of PL/pgSQL function "accept_ingress" near line 3
--
--    补掉那一层之后还有下一层（permission denied for function current_tenant_id），
--    一共 34/76 个对象的属主和生产不同。也就是说**一次照迁移做的灾难恢复，会得到
--    一个一封上行都收不了的库**——而且它看起来完好：70 条迁移零报错、RLS 和策略
--    和生产逐字节相同。
--
-- ⚠️ 这条测试为什么必须存在，而不是「迁移改完就算了」：
--
--    整套 DB 测试都以**超级用户**跑，而超级用户绕过 RLS、也不会碰到任何权限
--    问题。所以在此之前，这个套件在结构上就看不见这一整类缺陷 —— 属主错了、
--    授权漏了，它一条都抓不到。这是套件里第一条**换一个身份**去写的测试。
--
-- ⚠️ `run-tests.sh` 里曾经有四条 GRANT 在跑测试之前把库补好，注释自己写着
--    「夹具，不是修复」。它们随 0071 一起删掉了。**不要加回来** —— 加回来之后
--    这条测试就变成一个绿色的谎：它测的正是「重放出来的库行不行」，而补丁会替
--    迁移把那件事做了。
--
-- 这里不自己重放（run-tests.sh 已经把 base 库按全部迁移重放好了，每个测试从它
-- 克隆一份），所以这条测试断言的就是那个重放结果。

BEGIN;

-- 一个租户和一台设备，用超级用户建 —— 生产上这一步是开户做的，不在上行路径上。
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('6d365858-0000-4000-8000-000000000001', 'm6', 'M6 restore', 'active', 'cn');

SELECT set_config('app.tenant_id', '6d365858-0000-4000-8000-000000000001', true);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES ('6d365858-0000-4000-8000-000000000002',
        '6d365858-0000-4000-8000-000000000001',
        '860000000000001', 'restore-probe', 'iot');

-- 🔴 换成网关真正用的角色。这一行是整条测试的全部意义：以超级用户跑，
--    下面每一句都会通过，而那正是这一类缺陷藏了这么久的原因。
SET ROLE vodoge_gateway;
SELECT set_config('app.tenant_id', '6d365858-0000-4000-8000-000000000001', true);

DO $$
DECLARE
    result text;
BEGIN
    SELECT status INTO result
      FROM app.accept_ingress(
        '6d365858-0000-4000-8000-000000000001'::uuid,
        '6d365858-0000-4000-8000-000000000002'::uuid,
        1::bigint,
        '6d365858-0000-4000-8000-000000000003'::uuid,
        'DeviceState',
        '{"kind":"DeviceState","state":{}}'::jsonb);

    IF result IS DISTINCT FROM 'inserted' THEN
        RAISE EXCEPTION '以 vodoge_gateway 身份收上行得到 %，期望 inserted', result;
    END IF;
END
$$;

-- 收下来的那一行真的在，而且带着正确的租户。
DO $$
DECLARE
    rows integer;
BEGIN
    SELECT count(*) INTO rows
      FROM app.ingress
     WHERE tenant_id = '6d365858-0000-4000-8000-000000000001'
       AND device_id = '6d365858-0000-4000-8000-000000000002'
       AND seq = 1;
    IF rows <> 1 THEN
        RAISE EXCEPTION 'accept_ingress 说 inserted，但 app.ingress 里有 % 行', rows;
    END IF;
END
$$;

-- 命令那条路也走一次：它经过另一组 SECURITY DEFINER 函数，属主漂移在那边同样
-- 会挡住整条链（enqueue_command 在重放库里曾经归超级用户）。
DO $$
DECLARE
    command_id uuid;
BEGIN
    SELECT id INTO command_id
      FROM app.enqueue_command(
        '6d365858-0000-4000-8000-000000000001'::uuid,
        '6d365858-0000-4000-8000-000000000002'::uuid,
        'refresh_modems',
        '{}'::jsonb,
        'restore-probe-key',
        now() + interval '1 hour');
    IF command_id IS NULL THEN
        RAISE EXCEPTION '以 vodoge_gateway 身份入队命令，没有拿到 id';
    END IF;
END
$$;

RESET ROLE;
ROLLBACK;
