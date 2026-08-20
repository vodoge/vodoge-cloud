\set ON_ERROR_STOP on

-- Tenant directory is in the same database as business rows. Slug lookup does
-- not need SET LOCAL; row access still does.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '77777777-7777-7777-7777-777777777777';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '77777777-7777-7777-7777-777777777777',
    'catalog-apple',
    'Catalog Apple',
    'active',
    'cn'
);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '88888888-8888-8888-8888-888888888888';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '88888888-8888-8888-8888-888888888888',
    'catalog-orange',
    'Catalog Orange',
    'active',
    'intl'
);
COMMIT;

BEGIN;
RESET app.tenant_id;

DO $$
DECLARE
    v_id uuid;
    v_region text;
    v_status text;
    v_count integer;
BEGIN
    SELECT id, region, status
      INTO v_id, v_region, v_status
      FROM app.resolve_tenant('catalog-apple');
    IF v_id <> '77777777-7777-7777-7777-777777777777'
        OR v_region <> 'cn'
        OR v_status <> 'active' THEN
        RAISE EXCEPTION 'resolve_tenant = %, %, %', v_id, v_region, v_status;
    END IF;

    IF EXISTS (SELECT 1 FROM app.resolve_tenant('missing-tenant')) THEN
        RAISE EXCEPTION 'unknown slug must not resolve a tenant';
    END IF;

    SELECT count(*) INTO v_count FROM app.tenants;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'direct tenant read without SET LOCAL returned % rows', v_count;
    END IF;
END
$$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '77777777-7777-7777-7777-777777777777';

DO $$
DECLARE
    v_count integer;
    v_region text;
BEGIN
    SELECT count(*) INTO v_count FROM app.tenants;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'tenant A saw % tenant rows, want 1', v_count;
    END IF;

    BEGIN
        UPDATE app.tenants SET region = 'intl' WHERE slug = 'catalog-apple';
        RAISE EXCEPTION 'tenant region change was allowed';
    EXCEPTION WHEN integrity_constraint_violation THEN
        NULL;
    END;

    SELECT region INTO v_region FROM app.tenants WHERE slug = 'catalog-apple';
    IF v_region <> 'cn' THEN
        RAISE EXCEPTION 'tenant region mutated to %', v_region;
    END IF;

    BEGIN
        INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
        VALUES (
            'ffffffff-ffff-ffff-ffff-ffffffffffff',
            '88888888-8888-8888-8888-888888888888',
            '860000000000008',
            'cross-tenant-device',
            'cn'
        );
        RAISE EXCEPTION 'device insert for another tenant was allowed';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$$;
COMMIT;

RESET ROLE;
