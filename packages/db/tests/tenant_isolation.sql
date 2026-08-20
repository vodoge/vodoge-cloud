\set ON_ERROR_STOP on

-- This test must run as an administrative migration role after bootstrap/roles.sql
-- and migrations/0001_regional_data.sql. SET ROLE is intentional: superusers and
-- roles with BYPASSRLS are not meaningful RLS test subjects.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'apple',
    'Apple',
    'active',
    'cn'
);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    '860000000000001',
    'tenant-a-device',
    'cn'
);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '22222222-2222-2222-2222-222222222222',
    'orange',
    'Orange',
    'active',
    'intl'
);

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM app.devices;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'tenant B unexpectedly read % tenant A device rows', v_count;
    END IF;

    BEGIN
        INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
        VALUES (
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '11111111-1111-1111-1111-111111111111',
            '860000000000002',
            'cross-tenant-write',
            'cn'
        );
        RAISE EXCEPTION 'RLS did not reject a cross-tenant write';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$$;
COMMIT;

BEGIN;
RESET app.tenant_id;

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM app.devices;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'query without tenant context read % rows', v_count;
    END IF;
END
$$;
COMMIT;

RESET ROLE;
