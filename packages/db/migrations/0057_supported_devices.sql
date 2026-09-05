-- 受支持硬件列表。**跨租户，租户只读。**
--
-- 「支持」在这套系统里是两件事的合取：
--
--   1. 这个 build 里有策略驱动这个 USB 硬件 —— 代码说了算
--      （edge-core/src/strategies/modems.rs 的 usb_identities）
--   2. 目录里启用了 —— 这张表说了算
--
-- 第 2 条此前不存在，于是「支持」只有代码那一半：任何能被枚举出来的模组，
-- 只要探测没崩，都能被纳管。
--
-- # 为什么没有 tenant_id
--
-- 「我们支持哪些硬件」是跨租户事实。让租户能写它，就意味着 A 租户的一次改动
-- 能让 B 租户的设备被解绑 —— 那不是权限粒度问题，是这类配置根本不属于租户。
--
-- 所以：所有租户可读，只有 owner 可写。写入面将来收归 admin.vodoge.com
-- （见 docs/device-catalogue.md），在那之前唯一的写入者是 owner 自己
-- （psql / publish-ledger）。
--
-- # 🔴 空表不等于「什么都不支持」
--
-- 渲染成矩阵文档时，**表为空就整个不写 `[[device]]` 键**。
--
-- 边缘端的 DeviceGate 分得很清：没有这个段是 `NotStated`（放行，向后兼容），
-- 有段而某个硬件不在里面是 `Absent`（拒）。所以写一个空的 `[[device]]` 列表
-- 会拒掉**每一块**硬件 —— 和 `PUT /v1/capability-matrix` 收下
-- `{"version":"x"}` 是同一个形状的灾难，而那个已经在 matrix.Parse 里堵上了。
--
-- 这条规则的执行点在 Go 侧（ledger.Document），不在这里；这段注释是为了让
-- 读到这张表为空的人知道那不是「一切都禁」。
BEGIN;

CREATE TABLE IF NOT EXISTS app.supported_devices (
    -- sysfs 的 idVendor / idProduct，小写四位十六进制。分成两列而不是一个
    -- "2c7c:0125" 串：拼接的形状只在渲染时需要，而分开的能被约束住。
    usb_vendor text NOT NULL,
    usb_product text NOT NULL,
    -- 必须是这个 build 里真有的策略 id（quectel-ec / quectel-ec200u / …）。
    -- 数据库不能凭空启用一个代码里不存在的策略——真启用了也只会在运行期炸，
    -- 而这里无法校验它，所以它是**记录**，由边缘端在解析时对照。
    strategy text NOT NULL,
    -- 停用一条要明确写 false。列在这张表里本身就是「我们支持它」的表态。
    enabled boolean NOT NULL DEFAULT true,
    -- 为什么支持它、什么时候在什么硬件上验过。和 support_ledger 的 note
    -- 同一个用途：把「谁在什么时候凭什么加的」留在库里，而不是留在记忆里。
    note text,
    added_at timestamptz NOT NULL DEFAULT now(),
    added_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (usb_vendor, usb_product),
    CONSTRAINT supported_devices_usb_is_hex CHECK (
        usb_vendor ~ '^[0-9a-f]{4}$' AND usb_product ~ '^[0-9a-f]{4}$'
    ),
    CONSTRAINT supported_devices_strategy_named
        CHECK (length(btrim(strategy)) BETWEEN 1 AND 64),
    CONSTRAINT supported_devices_added_by_named
        CHECK (length(btrim(added_by)) BETWEEN 1 AND 128)
);

ALTER TABLE app.supported_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.supported_devices FORCE ROW LEVEL SECURITY;

-- 🔴 只有读策略，**没有写策略**。
--
-- FORCE ROW LEVEL SECURITY 让 owner 也受策略约束，所以写入必须由一个
-- BYPASSRLS 的角色或表的属主在关闭 FORCE 时进行 —— 这是有意的摩擦：
-- 跨租户配置不该能被一次普通的应用写入改掉。
CREATE POLICY readable_by_every_tenant ON app.supported_devices
    FOR SELECT USING (true);

REVOKE ALL ON app.supported_devices FROM PUBLIC;
-- 只给 SELECT。租户侧（vodoge_app）永远只读。
GRANT SELECT ON app.supported_devices TO vodoge_app;
ALTER TABLE app.supported_devices OWNER TO vodoge_owner;

COMMENT ON TABLE app.supported_devices IS
    'Cross-tenant list of USB hardware this fleet is allowed to adopt. Tenants read it and never write it; an empty table renders as no [[device]] section at all, which the edge reads as "not stated" rather than "nothing is supported".';

COMMENT ON COLUMN app.supported_devices.strategy IS
    'The edge strategy id that drives this hardware. Recorded here and checked by the edge at parse time; the database cannot verify that this build has it.';

COMMIT;
