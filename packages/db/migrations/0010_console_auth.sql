BEGIN;

-- Console operators and their sessions.
--
-- Until now the gateway derived the tenant from the Host header alone, so
-- anything that could reach its HTTP port could claim to be any tenant. The
-- only thing stopping that was the port being bound to localhost, which is a
-- deployment detail rather than a boundary. Identity now comes from a session,
-- and Host becomes a cross-check.

CREATE TABLE app.users (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    email text NOT NULL,
    -- bcrypt output. The plaintext never reaches this database.
    password_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_tenant_email_key UNIQUE (tenant_id, email),
    CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE app.sessions (
    -- The token itself is never stored. A database dump then does not hand
    -- over live sessions, only their fingerprints.
    token_sha256 bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT sessions_token_length CHECK (octet_length(token_sha256) = 32),
    CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON app.sessions (user_id);
CREATE INDEX sessions_expiry_idx ON app.sessions (expires_at);

-- Credential lookup happens before any tenant context exists, but the caller
-- must already know which tenant it is asking about: the Host scopes the
-- attempt, and the password still has to match. Returning the hash rather than
-- doing the comparison here keeps bcrypt cost out of the database.
CREATE OR REPLACE FUNCTION app.resolve_user(p_tenant_id uuid, p_email text)
RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    email text,
    password_hash text,
    status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    SELECT u.id, u.tenant_id, u.email, u.password_hash, u.status
      FROM app.users AS u
     WHERE u.tenant_id = p_tenant_id
       AND u.email = lower(p_email)
$$;

-- Session lookup cannot be scoped by tenant, because the session is what says
-- which tenant the caller belongs to. Expired rows are filtered here so no
-- caller can forget to.
CREATE OR REPLACE FUNCTION app.resolve_session(p_token_sha256 bytea)
RETURNS TABLE (
    user_id uuid,
    tenant_id uuid,
    expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    SELECT s.user_id, s.tenant_id, s.expires_at
      FROM app.sessions AS s
     WHERE s.token_sha256 = p_token_sha256
       AND s.expires_at > now()
$$;

CREATE OR REPLACE FUNCTION app.create_session(
    p_token_sha256 bytea,
    p_user_id uuid,
    p_tenant_id uuid,
    p_expires_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    INSERT INTO app.sessions (token_sha256, user_id, tenant_id, expires_at)
    VALUES (p_token_sha256, p_user_id, p_tenant_id, p_expires_at)
$$;

CREATE OR REPLACE FUNCTION app.delete_session(p_token_sha256 bytea)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    DELETE FROM app.sessions WHERE token_sha256 = p_token_sha256
$$;

-- Expired rows are ignored by resolve_session, but they still accumulate.
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

-- Direct table reads stay inside RLS. Only the resolvers above step outside it,
-- and each one is narrow enough to audit.
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.users
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON app.sessions
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.users FROM PUBLIC;
REVOKE ALL ON app.sessions FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_user(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_expired_sessions() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON app.users TO vodoge_app;
GRANT SELECT, INSERT, DELETE ON app.sessions TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_user(uuid, text) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.create_session(bytea, uuid, uuid, timestamptz) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.delete_session(bytea) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO vodoge_app;

COMMIT;
