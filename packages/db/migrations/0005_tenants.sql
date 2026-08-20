BEGIN;

-- Tenant directory lives in the same database as devices and messages.
-- Isolation is the tenant_id column plus RLS, not a second PostgreSQL.
CREATE TABLE app.tenants (
    id uuid PRIMARY KEY,
    slug text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    region text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_key UNIQUE (slug),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
    CONSTRAINT tenants_status_valid CHECK (status IN ('active', 'suspended', 'disabled')),
    CONSTRAINT tenants_region_valid CHECK (region IN ('cn', 'intl'))
);

CREATE INDEX tenants_region_idx ON app.tenants (region);

CREATE OR REPLACE FUNCTION app.forbid_tenant_region_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.region IS DISTINCT FROM OLD.region THEN
        RAISE EXCEPTION 'tenant region is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tenants_region_immutable ON app.tenants;
CREATE TRIGGER tenants_region_immutable
    BEFORE UPDATE ON app.tenants
    FOR EACH ROW
    EXECUTE FUNCTION app.forbid_tenant_region_change();

-- Host/slug lookup has to work before SET LOCAL app.tenant_id. Direct table
-- reads still go through RLS; only this function turns row_security off.
CREATE OR REPLACE FUNCTION app.resolve_tenant(p_slug text)
RETURNS TABLE (
    id uuid,
    slug text,
    name text,
    status text,
    region text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
    SELECT t.id, t.slug, t.name, t.status, t.region
      FROM app.tenants AS t
     WHERE t.slug = p_slug
$$;

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.tenants
    USING (id = app.current_tenant_id())
    WITH CHECK (id = app.current_tenant_id());

ALTER TABLE app.devices
    ADD CONSTRAINT devices_tenant_fkey
    FOREIGN KEY (tenant_id)
    REFERENCES app.tenants (id);

REVOKE ALL ON app.tenants FROM PUBLIC;
REVOKE ALL ON FUNCTION app.forbid_tenant_region_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_tenant(text) FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.tenants TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text) TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.forbid_tenant_region_change() TO vodoge_app;

COMMIT;
