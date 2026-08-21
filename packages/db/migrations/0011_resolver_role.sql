BEGIN;

-- The pre-context resolvers could not run.
--
-- app.resolve_tenant is SECURITY DEFINER with row_security = off, which reads
-- as "bypass RLS". It is not. Turning row_security off makes PostgreSQL raise
-- an error when a policy would apply and the current role cannot bypass it,
-- and a SECURITY DEFINER function runs as its owner — vodoge_owner, which owns
-- app.tenants and is therefore inside FORCE ROW LEVEL SECURITY like everyone
-- else. Every tenant lookup failed with "query would be affected by row-level
-- security policy". Devices were unaffected because their tenant comes from the
-- client certificate, so only the console path was broken.
--
-- Giving vodoge_owner BYPASSRLS would fix it and hand every SECURITY DEFINER
-- function it owns the run of the whole database. Instead a role exists whose
-- only purpose is to own these three lookups. It cannot log in, and its bypass
-- is reachable only through their fixed queries.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_resolver') THEN
        CREATE ROLE vodoge_resolver NOLOGIN BYPASSRLS;
    ELSE
        ALTER ROLE vodoge_resolver NOLOGIN BYPASSRLS;
    END IF;
END
$$;

ALTER FUNCTION app.resolve_tenant(text) OWNER TO vodoge_resolver;
ALTER FUNCTION app.resolve_user(uuid, text) OWNER TO vodoge_resolver;
ALTER FUNCTION app.resolve_session(bytea) OWNER TO vodoge_resolver;

-- These write rather than read, so they must stay inside the tenant's own
-- policies. They are SECURITY DEFINER only so the app role need not own the
-- table, and they keep vodoge_owner as their owner.
ALTER FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) OWNER TO vodoge_owner;
ALTER FUNCTION app.delete_session(bytea) OWNER TO vodoge_owner;
ALTER FUNCTION app.purge_expired_sessions() OWNER TO vodoge_owner;

-- 0010 left these owned by whoever applied it, so the schema depended on which
-- account ran the migration. Ownership is stated here instead of inherited.
ALTER TABLE app.users OWNER TO vodoge_owner;
ALTER TABLE app.sessions OWNER TO vodoge_owner;

-- The resolver owns the functions but not the tables, so it needs read access
-- to what they select. Read only: its bypass must not become a way to write.
GRANT USAGE ON SCHEMA app TO vodoge_resolver;
GRANT SELECT ON app.tenants TO vodoge_resolver;
GRANT SELECT ON app.users TO vodoge_resolver;
GRANT SELECT ON app.sessions TO vodoge_resolver;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.tenants FROM vodoge_resolver;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.users FROM vodoge_resolver;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.sessions FROM vodoge_resolver;

GRANT SELECT, INSERT, UPDATE ON app.users TO vodoge_app;
GRANT SELECT, INSERT, DELETE ON app.sessions TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_user(uuid, text) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.delete_session(bytea) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO vodoge_app;

COMMIT;
