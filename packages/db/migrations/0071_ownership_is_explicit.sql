-- 照迁移重放出来的库，一封设备上行都收不了。
--
-- 🔴 实测（2026-09-15，把 70 条迁移重放到空库，再以 vodoge_gateway 身份调用）：
--
--      ERROR:  permission denied for schema app
--      CONTEXT:  compilation of PL/pgSQL function "accept_ingress" near line 3
--
--    补掉那一层之后是下一层：
--
--      ERROR:  permission denied for function current_tenant_id
--
--    一共 34/76 个 app 对象的属主和生产不同。
--
-- ## 根因不是漏了一条 GRANT，是属主由「谁跑的迁移」隐式决定
--
-- 这个仓库有**两个**迁移执行器：
--
--   deploy/migrate.sh      硬编码 0001-0009，以 vodoge_owner 身份跑（owner_psql）
--   deploy/bin/migrate.sh  以 $PG_USER（超级用户）跑其余
--
-- 而 **0001-0009 里一条 `OWNER TO` 都没有** —— 后面 28 个迁移里有 239 条，前九个
-- 一条也没有。所以那九个迁移建的对象归谁，完全取决于当时是哪个执行器在跑。
--
-- 证据是可预测性：重放库里归超级用户的 15 张表，正好是 0001-0009 建的那 14 张
-- 加 scheduled_tasks（后者在生产上也归超级用户，见下面的例外表）。
--
-- ⚠️ `packages/db/run-tests.sh` 早就把这件事写在注释里了，并且说「这是个真问题，
--    需要单独决定怎么修（补授权？还是让迁移显式设属主？后者会动生产的权限模型），
--    不该由这里顺手定」。这个文件就是那个决定：**让迁移显式设属主**。
--
-- ## 为什么每一条都先判属主
--
-- 🔴 实测：`ALTER TABLE … OWNER TO` **即使属主没有变化也取 AccessExclusiveLock**。
--
--    所以一个「在生产上是无操作」的迁移，照样会把 app.ingress 锁住 —— 而那是每
--    一封上行都要写的表。2026-09-10 改一个 SECURITY DEFINER 函数的属主造成过
--    2 分 40 秒的全线上行失败；同一个形状不再走第二遍。
--
--    下面每一条都在 `IF 当前属主 <> 目标` 里面。属主已经对的对象**一条语句都不
--    执行**，因此一把锁都不取。在生产上这整个迁移是真正的零动作。
--
-- ## 规则 + 例外，而不是一张清单
--
-- 规则：schema app 里的一切归 vodoge_owner。
--
-- ⚠️ 例外必须写下来，因为**生产自己也不是统一属主**：一张表和 9 个 SECURITY
--    DEFINER 函数归超级用户 vodoge。写成「一切都归 vodoge_owner」会在生产上变红，
--    而一道在真实环境里永远触发的检查不是严格，它是坏的。
--
-- 🔴 那 9 个函数**不能**顺手改属主。它们是 SECURITY DEFINER，属主是超级用户
--    意味着函数体内 RLS 完全不生效，而它们的 SQL 正是照这个前提写的（0067/0068
--    的注释逐字写着「FORCE RLS 在这里完全不生效，条件必须自己写严」）。把属主换
--    成非超级用户会让 RLS 突然生效，那是行为变更，不是权限修复 —— 要做也得单独
--    做，配一套自己的测试。
--
-- 用规则而不是清单，新加的对象自动归位；例外短、且每一条都解释得清。
BEGIN;

DO $$
DECLARE
    -- 生产上归超级用户的那些。列在这里不是"应该如此"，是"目前如此"——
    -- packages/db/tests/ownership_survives_a_replay.sql 会拿生产快照核对它。
    exempt_tables CONSTANT text[] := ARRAY['scheduled_tasks'];
    exempt_functions CONSTANT text[] := ARRAY[
        'apply_managed_modems',
        'claim_due_scheduled_tasks',
        'expire_overdue_commands',
        'expire_overdue_tenant_commands',
        'finish_scheduled_task',
        'project_alerts',
        'project_managed_modems',
        'project_modem_candidates',
        'record_unstorable_ingress'
    ];
    target CONSTANT name := 'vodoge_owner';
    obj record;
    changed integer := 0;
BEGIN
    -- schema 本身。这是第一道砖：vodoge_owner 没有 USAGE，它拥有的每一个
    -- SECURITY DEFINER 函数连编译都过不了。
    IF EXISTS (
        SELECT 1 FROM pg_namespace
         WHERE nspname = 'app' AND pg_get_userbyid(nspowner) <> target
    ) THEN
        EXECUTE format('ALTER SCHEMA app OWNER TO %I', target);
        changed := changed + 1;
    END IF;

    -- 表（含分区表）。
    FOR obj IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app'
           AND c.relkind IN ('r', 'p')
           AND NOT (c.relname = ANY (exempt_tables))
           AND pg_get_userbyid(c.relowner) <> target
    LOOP
        EXECUTE format('ALTER TABLE app.%I OWNER TO %I', obj.relname, target);
        changed := changed + 1;
    END LOOP;

    -- 视图。
    FOR obj IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app'
           AND c.relkind = 'v'
           AND pg_get_userbyid(c.relowner) <> target
    LOOP
        EXECUTE format('ALTER VIEW app.%I OWNER TO %I', obj.relname, target);
        changed := changed + 1;
    END LOOP;

    -- 序列。0001-0009 里一条 OWNER TO 都没有，序列更是从来没人写过。
    FOR obj IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app'
           AND c.relkind = 'S'
           AND pg_get_userbyid(c.relowner) <> target
    LOOP
        EXECUTE format('ALTER SEQUENCE app.%I OWNER TO %I', obj.relname, target);
        changed := changed + 1;
    END LOOP;

    -- 枚举等类型。
    FOR obj IN
        SELECT t.typname
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'app'
           AND t.typtype IN ('e', 'd', 'c')
           -- 复合类型里那些是表自己的行类型，跟着表走，单独 ALTER 会报错。
           AND NOT EXISTS (
               SELECT 1 FROM pg_class c
                WHERE c.reltype = t.oid AND c.relkind IN ('r', 'p', 'v', 'S')
           )
           AND pg_get_userbyid(t.typowner) <> target
    LOOP
        EXECUTE format('ALTER TYPE app.%I OWNER TO %I', obj.typname, target);
        changed := changed + 1;
    END LOOP;

    -- 函数与存储过程。
    --
    -- ⚠️ 用 oid::regprocedure 而不是名字：这个 schema 里有同名不同签名的函数
    --    （expire_overdue_commands 就有两个重载），按名字 ALTER 会报
    --    "is not unique"。
    FOR obj IN
        SELECT p.oid, p.proname
          FROM pg_proc p
         WHERE p.pronamespace = 'app'::regnamespace
           AND NOT (p.proname = ANY (exempt_functions))
           AND pg_get_userbyid(p.proowner) <> target
           -- vodoge_resolver 拥有的那 5 个是另一套身份，不动。
           AND pg_get_userbyid(p.proowner) <> 'vodoge_resolver'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I', obj.oid::regprocedure, target);
        changed := changed + 1;
    END LOOP;

    RAISE NOTICE '0071: 改了 % 个对象的属主（生产上应当是 0）', changed;
END
$$;

-- 属主对了还不够：SECURITY DEFINER 函数以属主身份运行，而属主要能调到它自己
-- 依赖的那些函数。生产上 vodoge_owner 是这些对象的属主所以隐式够得到；重放出来
-- 的库里它可能只是个旁观者。
--
-- ⚠️ GRANT 不取表锁，而且重复授予是无操作，所以这几条不需要先判断。
GRANT USAGE ON SCHEMA app TO vodoge_owner;

COMMIT;
