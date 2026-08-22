BEGIN;

-- The old product's settings were machine-global: one box, one owner, one set
-- of notification channels and SMS limits. Under multi-tenancy every one of
-- those belongs to a tenant, so they are stored per tenant and read through
-- the same RLS policies as everything else.
--
-- Stored one row per section rather than one column per setting. The sections
-- are independent, they change at different times, and a schema migration for
-- every new notification channel is a cost with nothing to show for it. The
-- gateway validates the shape on the way in; the database enforces only that
-- it is an object, because a partially-written settings row is worse than a
-- rejected one.
CREATE TABLE app.tenant_settings (
    tenant_id uuid NOT NULL,
    section text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    PRIMARY KEY (tenant_id, section),
    CONSTRAINT tenant_settings_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    CONSTRAINT tenant_settings_value_is_object CHECK (jsonb_typeof(value) = 'object'),
    -- Sections are a closed set. A typo would otherwise create a section that
    -- silently holds settings nothing ever reads.
    CONSTRAINT tenant_settings_section_known
        CHECK (section IN ('notifications', 'sms', 'security', 'devices'))
);

ALTER TABLE app.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.tenant_settings
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.tenant_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.tenant_settings TO vodoge_app;

ALTER TABLE app.tenant_settings OWNER TO vodoge_owner;

COMMIT;
