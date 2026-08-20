BEGIN;

CREATE TABLE app.rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    matcher jsonb NOT NULL,
    action jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rules_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES app.tenants (id),
    CONSTRAINT rules_matcher_is_object CHECK (jsonb_typeof(matcher) = 'object'),
    CONSTRAINT rules_action_is_object CHECK (jsonb_typeof(action) = 'object')
);

CREATE INDEX rules_tenant_enabled_idx ON app.rules (tenant_id, enabled);

CREATE TABLE app.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    target text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_log_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES app.tenants (id),
    CONSTRAINT audit_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX audit_log_tenant_at_idx ON app.audit_log (tenant_id, at DESC);

ALTER TABLE app.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.rules
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.audit_log
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.rules FROM PUBLIC;
REVOKE ALL ON app.audit_log FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.rules TO vodoge_app;
GRANT SELECT, INSERT ON app.audit_log TO vodoge_app;

COMMIT;
