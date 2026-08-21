BEGIN;

-- 0010 wrote the session functions with `SET row_security = off`, which reads
-- as "bypass RLS" and is not: under FORCE ROW LEVEL SECURITY it raises an error
-- unless the executing role can bypass policies. 0011 fixed the read-side
-- resolvers by giving them an owner that can; these three were left behind and
-- every sign-in failed on the INSERT.
--
-- They are not all the same risk, so they do not get the same treatment.

-- Creating a session is the one operation here that can manufacture access, so
-- it stays inside row-level security rather than stepping around it. The tenant
-- is known from the argument, so the function sets the transaction-local
-- context and the existing policy then checks the row on its way in. A bug that
-- passed the wrong tenant would be caught by the policy instead of being
-- written through it.
CREATE OR REPLACE FUNCTION app.create_session(
    p_token_sha256 bytea,
    p_user_id uuid,
    p_tenant_id uuid,
    p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
    INSERT INTO app.sessions (token_sha256, user_id, tenant_id, expires_at)
    VALUES (p_token_sha256, p_user_id, p_tenant_id, p_expires_at);
END
$$;

-- Removing a session cannot grant anything, and both callers run without a
-- tenant context: sign-out knows only the token, and the sweep is keyed on
-- expiry across every tenant. These keep the bypassing owner, whose reach is
-- limited to what the grants below allow.
CREATE OR REPLACE FUNCTION app.delete_session(p_token_sha256 bytea)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    DELETE FROM app.sessions WHERE token_sha256 = p_token_sha256
$$;

CREATE OR REPLACE FUNCTION app.purge_expired_sessions()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
    removed bigint;
BEGIN
    DELETE FROM app.sessions WHERE expires_at <= now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END
$$;

ALTER FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) OWNER TO vodoge_owner;
ALTER FUNCTION app.delete_session(bytea) OWNER TO vodoge_resolver;
ALTER FUNCTION app.purge_expired_sessions() OWNER TO vodoge_resolver;

-- The bypassing role may now delete sessions, and nothing else new. It still
-- cannot insert one, so it cannot mint access; it cannot touch users or
-- tenants beyond reading them.
GRANT DELETE ON app.sessions TO vodoge_resolver;
REVOKE INSERT, UPDATE, TRUNCATE ON app.sessions FROM vodoge_resolver;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.users FROM vodoge_resolver;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.tenants FROM vodoge_resolver;

REVOKE ALL ON FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.delete_session(bytea) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO vodoge_app;

COMMIT;
