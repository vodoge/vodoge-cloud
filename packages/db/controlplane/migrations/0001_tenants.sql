BEGIN;

CREATE SCHEMA IF NOT EXISTS control;

-- Global control plane: tenant-to-region routing only. Business data never
-- lives here. A tenant's region is chosen at creation and cannot change.
CREATE TABLE control.tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX tenants_region_idx ON control.tenants (region);

CREATE OR REPLACE FUNCTION control.forbid_tenant_region_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.region IS DISTINCT FROM OLD.region THEN
        RAISE EXCEPTION 'tenant region is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_region_immutable ON control.tenants;
CREATE TRIGGER tenants_region_immutable
    BEFORE UPDATE ON control.tenants
    FOR EACH ROW
    EXECUTE FUNCTION control.forbid_tenant_region_change();

COMMIT;
