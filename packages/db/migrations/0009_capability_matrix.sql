BEGIN;

-- Per-tenant overlay of the product capability matrix. Changing this row is
-- what C-12 means by "改云端数据即可改变边缘端判定": the gateway enqueues
-- UpdateCapabilityMatrix to each device after a successful write.
CREATE TABLE app.capability_matrix (
    tenant_id uuid PRIMARY KEY
        REFERENCES app.tenants (id),
    version text NOT NULL,
    sha256 text NOT NULL,
    document jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT capability_matrix_document_is_object
        CHECK (jsonb_typeof(document) = 'object'),
    CONSTRAINT capability_matrix_version_not_empty
        CHECK (length(btrim(version)) > 0),
    CONSTRAINT capability_matrix_sha256_not_empty
        CHECK (length(btrim(sha256)) > 0)
);

ALTER TABLE app.capability_matrix ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.capability_matrix FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.capability_matrix
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.capability_matrix FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.capability_matrix TO vodoge_app;

COMMIT;
