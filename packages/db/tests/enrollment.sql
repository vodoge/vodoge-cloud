\set ON_ERROR_STOP on

-- C-11: a code is consumed once, never for another tenant, and the assigned
-- device_id is what the gateway writes as the certificate CN.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '90909090-9090-4909-8909-909090909090';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '90909090-9090-4909-8909-909090909090',
    'enroll-apple',
    'Enroll Apple',
    'active',
    'cn'
);

INSERT INTO app.enrollment_codes (tenant_id, code, expires_at)
VALUES (
    '90909090-9090-4909-8909-909090909090',
    'enroll-code-apple-once',
    now() + interval '1 hour'
);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '91919191-9191-4919-8919-919191919191';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '91919191-9191-4919-8919-919191919191',
    'enroll-orange',
    'Enroll Orange',
    'active',
    'intl'
);

INSERT INTO app.enrollment_codes (tenant_id, code, expires_at)
VALUES (
    '91919191-9191-4919-8919-919191919191',
    'enroll-code-orange-once',
    now() + interval '1 hour'
);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '90909090-9090-4909-8909-909090909090';

DO $$
DECLARE
    v_device uuid;
    v_tenant uuid;
    v_region text;
    v_second uuid;
    v_count integer;
BEGIN
    SELECT c.device_id, c.tenant_id, c.region
      INTO v_device, v_tenant, v_region
      FROM app.consume_enrollment_code(
          '90909090-9090-4909-8909-909090909090',
          'enroll-code-apple-once',
          'csr-hint'
      ) AS c;

    IF v_tenant <> '90909090-9090-4909-8909-909090909090' THEN
        RAISE EXCEPTION 'consume tenant_id = %', v_tenant;
    END IF;
    IF v_region <> 'cn' THEN
        RAISE EXCEPTION 'consume region = %, want cn from tenant', v_region;
    END IF;
    IF v_device IS NULL THEN
        RAISE EXCEPTION 'consume did not assign a device_id';
    END IF;

    BEGIN
        SELECT c.device_id
          INTO v_second
          FROM app.consume_enrollment_code(
              '90909090-9090-4909-8909-909090909090',
              'enroll-code-apple-once',
              'csr-hint'
          ) AS c;
        RAISE EXCEPTION 'reuse of enrollment code was allowed';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    BEGIN
        PERFORM * FROM app.consume_enrollment_code(
            '91919191-9191-4919-8919-919191919191',
            'enroll-code-orange-once',
            'csr-hint'
        );
        RAISE EXCEPTION 'wrong tenant consume was allowed';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    SELECT count(*) INTO v_count FROM app.enrollment_codes;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'tenant A saw % enrollment_codes rows, want 1', v_count;
    END IF;
END
$$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '91919191-9191-4919-8919-919191919191';

DO $$
DECLARE
    v_used timestamptz;
    v_region text;
BEGIN
    SELECT used_at INTO v_used
      FROM app.enrollment_codes
     WHERE code = 'enroll-code-orange-once';
    IF v_used IS NOT NULL THEN
        RAISE EXCEPTION 'tenant B code was consumed by tenant A';
    END IF;

    SELECT c.region
      INTO v_region
      FROM app.consume_enrollment_code(
          '91919191-9191-4919-8919-919191919191',
          'enroll-code-orange-once',
          NULL
      ) AS c;
    IF v_region <> 'intl' THEN
        RAISE EXCEPTION 'consume region = %, want intl from tenant', v_region;
    END IF;
END
$$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '90909090-9090-4909-8909-909090909090';

INSERT INTO app.enrollment_codes (tenant_id, code, expires_at)
VALUES (
    '90909090-9090-4909-8909-909090909090',
    'enroll-code-apple-expired',
    now() - interval '1 second'
);

DO $$
BEGIN
    PERFORM * FROM app.consume_enrollment_code(
        '90909090-9090-4909-8909-909090909090',
        'enroll-code-apple-expired',
        NULL
    );
    RAISE EXCEPTION 'expired enrollment code was consumed';
EXCEPTION WHEN data_exception THEN
    NULL;
END
$$;
COMMIT;

RESET ROLE;
