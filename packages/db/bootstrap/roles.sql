-- Run this once as a PostgreSQL administrator before applying regional migrations.
-- These roles intentionally have no LOGIN attribute. Deployment supplies narrowly
-- scoped login roles or grants membership to workload identities as appropriate.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_app') THEN
        CREATE ROLE vodoge_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vodoge_dispatcher') THEN
        CREATE ROLE vodoge_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
END
$$;

-- vodoge_dispatcher is deliberately not granted BYPASSRLS here. The delivery
-- worker receives access only through narrowly scoped SECURITY DEFINER functions
-- introduced with its implementation, rather than unrestricted table access.
