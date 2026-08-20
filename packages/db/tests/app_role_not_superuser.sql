\set ON_ERROR_STOP on

-- C-02: the runtime application role must never be a superuser. Superusers
-- bypass RLS, which would make the tenant isolation tests a false pass.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_app') THEN
        RAISE EXCEPTION 'vodoge_app role is missing';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_app' AND rolsuper) THEN
        RAISE EXCEPTION 'vodoge_app must not be a superuser';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_app' AND rolbypassrls) THEN
        RAISE EXCEPTION 'vodoge_app must not bypass RLS';
    END IF;
END
$$;
