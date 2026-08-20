BEGIN;

-- One-time enrollment codes are exchanged for a device mTLS certificate.
-- The edge generates the private key and CSR; this database only records the
-- consumed code, the assigned device_id, and the issued certificate's serial
-- and fingerprint so a single device can be revoked later.
CREATE TABLE app.enrollment_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    device_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT enrollment_codes_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES app.tenants (id),
    CONSTRAINT enrollment_codes_code_key UNIQUE (code),
    CONSTRAINT enrollment_codes_code_nonempty CHECK (length(btrim(code)) > 0),
    CONSTRAINT enrollment_codes_one_time CHECK (
        (used_at IS NULL AND device_id IS NULL)
        OR (used_at IS NOT NULL AND device_id IS NOT NULL)
    ),
    CONSTRAINT enrollment_codes_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id)
);

CREATE TABLE app.device_certificates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    serial text NOT NULL,
    fingerprint text NOT NULL,
    not_before timestamptz NOT NULL,
    not_after timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT device_certificates_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id),
    CONSTRAINT device_certificates_serial_key UNIQUE (serial),
    CONSTRAINT device_certificates_fingerprint_key UNIQUE (fingerprint),
    CONSTRAINT device_certificates_fingerprint_sha256
        CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT device_certificates_serial_nonempty
        CHECK (length(btrim(serial)) > 0),
    CONSTRAINT device_certificates_validity
        CHECK (not_after > not_before)
);

CREATE INDEX enrollment_codes_tenant_idx
    ON app.enrollment_codes (tenant_id, expires_at);
CREATE INDEX device_certificates_device_idx
    ON app.device_certificates (tenant_id, device_id);

-- Consumes a code exactly once, creates the device row, and returns the
-- identity the gateway must write on the signed certificate:
--   CN = device_id, O = tenant_id, OU = tenants.region.
-- p_csr_or_device_hint is not the identity; the CSR is signed in the gateway.
CREATE OR REPLACE FUNCTION app.consume_enrollment_code(
    p_tenant_id uuid,
    p_code text,
    p_csr_or_device_hint text
)
RETURNS TABLE (
    device_id uuid,
    tenant_id uuid,
    region text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_code app.enrollment_codes%ROWTYPE;
    v_region text;
    v_status text;
    v_device_id uuid;
    v_name text := 'enrolled';
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match enrollment tenant'
            USING ERRCODE = '42501';
    END IF;

    IF p_code IS NULL OR length(btrim(p_code)) = 0 THEN
        RAISE EXCEPTION 'enrollment code is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT t.region, t.status
      INTO v_region, v_status
      FROM app.tenants AS t
     WHERE t.id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'enrollment tenant not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_status <> 'active' THEN
        RAISE EXCEPTION 'enrollment tenant is not active'
            USING ERRCODE = '55000';
    END IF;

    SELECT c.*
      INTO v_code
      FROM app.enrollment_codes AS c
     WHERE c.tenant_id = p_tenant_id
       AND c.code = p_code
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'enrollment code not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_code.used_at IS NOT NULL THEN
        RAISE EXCEPTION 'enrollment code already used'
            USING ERRCODE = '55000';
    END IF;

    IF v_code.expires_at <= now() THEN
        RAISE EXCEPTION 'enrollment code expired'
            USING ERRCODE = '22000';
    END IF;

    IF p_csr_or_device_hint IS NOT NULL
        AND length(btrim(p_csr_or_device_hint)) BETWEEN 1 AND 128
        AND p_csr_or_device_hint NOT LIKE '%-----%' THEN
        v_name := btrim(p_csr_or_device_hint);
    END IF;

    v_device_id := gen_random_uuid();

    INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
    VALUES (
        v_device_id,
        p_tenant_id,
        'enroll-' || v_device_id::text,
        v_name,
        'edge'
    );

    UPDATE app.enrollment_codes AS c
       SET used_at = now(),
           device_id = v_device_id
     WHERE c.tenant_id = p_tenant_id
       AND c.code = p_code
       AND c.used_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'enrollment code already used'
            USING ERRCODE = '55000';
    END IF;

    device_id := v_device_id;
    tenant_id := p_tenant_id;
    region := v_region;
    RETURN NEXT;
END
$$;

ALTER TABLE app.enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.enrollment_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.device_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.device_certificates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.enrollment_codes
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.device_certificates
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.enrollment_codes FROM PUBLIC;
REVOKE ALL ON app.device_certificates FROM PUBLIC;
REVOKE ALL ON FUNCTION app.consume_enrollment_code(uuid, text, text) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON app.enrollment_codes TO vodoge_app;
GRANT SELECT, INSERT, UPDATE ON app.device_certificates TO vodoge_app;
GRANT EXECUTE ON FUNCTION app.consume_enrollment_code(uuid, text, text) TO vodoge_app;

COMMIT;
