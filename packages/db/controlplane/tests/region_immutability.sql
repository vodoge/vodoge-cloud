\set ON_ERROR_STOP on

BEGIN;

INSERT INTO control.tenants (id, slug, name, status, region)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'apple', 'Apple', 'active', 'cn'),
    ('22222222-2222-2222-2222-222222222222', 'orange', 'Orange', 'active', 'intl');

DO $$
DECLARE
    v_region text;
BEGIN
    SELECT region INTO v_region FROM control.tenants WHERE slug = 'apple';
    IF v_region <> 'cn' THEN
        RAISE EXCEPTION 'apple tenant region is %, want cn', v_region;
    END IF;

    BEGIN
        UPDATE control.tenants SET region = 'intl' WHERE slug = 'apple';
        RAISE EXCEPTION 'tenant region change was allowed';
    EXCEPTION
        WHEN integrity_constraint_violation THEN
            NULL;
    END;

    SELECT region INTO v_region FROM control.tenants WHERE slug = 'apple';
    IF v_region <> 'cn' THEN
        RAISE EXCEPTION 'apple tenant region mutated to %', v_region;
    END IF;
END
$$;

COMMIT;
