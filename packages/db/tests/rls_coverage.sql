\set ON_ERROR_STOP on

-- C-02b: every base table in schema app must FORCE RLS and have a policy.
-- A new table that forgets this is a silent cross-tenant hole.
DO $$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
      INTO v_missing
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND c.relkind = 'r'
       -- ⚠️ 只查**装租户数据**的表。原来这里查 schema app 下的每一张表，于是被
       --    app.schema_migrations 绊住 —— 那是迁移账本，没有 tenant_id，
       --    它不该有 RLS：给它加反而会让 bin/migrate.sh 记不了账。
       --    这条判据和 CI 里那一步（「Every table with a tenant_id enforces
       --    isolation」）必须是同一条，否则一红一绿会让人以为其中一个坏了。
       AND EXISTS (
           SELECT 1 FROM pg_attribute AS a
            WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
              AND a.attnum > 0 AND NOT a.attisdropped
       )
       AND (
           NOT c.relrowsecurity
           OR NOT c.relforcerowsecurity
           OR NOT EXISTS (
               SELECT 1
                 FROM pg_policy AS p
                WHERE p.polrelid = c.oid
           )
       );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'tables missing FORCE RLS or a policy: %', v_missing;
    END IF;
END
$$;
