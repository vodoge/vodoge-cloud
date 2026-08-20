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
