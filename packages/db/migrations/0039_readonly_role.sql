BEGIN;

-- Read-only console accounts.
--
-- Every account could change everything: the only distinction the product drew
-- was which tenant you belonged to. An operator who wanted to give someone
-- visibility -- a colleague watching a rollout, an auditor, a customer looking
-- at their own devices -- had to hand over an account that can restart a modem
-- and delete a device's entire journal.
--
-- The role lives on the account rather than on the session. A session row with
-- a role copied into it would make "make this account read-only" a promise the
-- product could not keep for another twelve hours, which is exactly when
-- someone reaches for it. Joining at resolve time costs nothing measurable --
-- the session lookup already reads a row keyed on a primary key -- and makes a
-- demotion take effect on the next request.
--
-- Two roles, not a grid of per-feature grants. The distinction an operator
-- actually draws is "can this account change anything", and a finer model
-- would need someone to remember to place each new route into it. The gateway
-- enforces the same way, in one place around the whole route table.

ALTER TABLE app.users ADD COLUMN role text NOT NULL DEFAULT 'admin';

-- 'admin' as the default is what makes this migration safe to apply before the
-- gateway that understands it: every account that exists today can already do
-- everything, and the column now says so out loud.
ALTER TABLE app.users
    ADD CONSTRAINT users_role_valid CHECK (role IN ('admin', 'readonly'));

-- Both resolvers gain a column, and CREATE OR REPLACE cannot do that:
-- PostgreSQL refuses to change a function's result type in place. Dropped and
-- recreated, which also drops the owner and the grants that 0010/0011/0012
-- established, so both are restated below. Getting that wrong is not a subtle
-- failure -- resolve_session owned by anyone without BYPASSRLS raises
-- "query would be affected by row-level security policy" and every console
-- session stops resolving at once (0011 is the write-up of that outage).
DROP FUNCTION app.resolve_user(uuid, text);

CREATE FUNCTION app.resolve_user(p_tenant_id uuid, p_email text)
RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    email text,
    password_hash text,
    status text,
    role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    SELECT u.id, u.tenant_id, u.email, u.password_hash, u.status, u.role
      FROM app.users AS u
     WHERE u.tenant_id = p_tenant_id
       AND u.email = lower(p_email)
$$;

DROP FUNCTION app.resolve_session(bytea);

-- An inner join, deliberately. A session whose account has gone should not
-- authenticate, and the cascade on app.sessions.user_id means the case does not
-- arise in the first place; a left join with a default role would turn an
-- impossible row into a working credential.
CREATE FUNCTION app.resolve_session(p_token_sha256 bytea)
RETURNS TABLE (
    user_id uuid,
    tenant_id uuid,
    expires_at timestamptz,
    role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    SELECT s.user_id, s.tenant_id, s.expires_at, u.role
      FROM app.sessions AS s
      JOIN app.users AS u ON u.id = s.user_id
     WHERE s.token_sha256 = p_token_sha256
       AND s.expires_at > now()
$$;

ALTER FUNCTION app.resolve_user(uuid, text) OWNER TO vodoge_resolver;
ALTER FUNCTION app.resolve_session(bytea) OWNER TO vodoge_resolver;

REVOKE ALL ON FUNCTION app.resolve_user(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_user(uuid, text) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO vodoge_app;

COMMIT;
