\set ON_ERROR_STOP on

-- Sequenced uplink rows are tenant-scoped and keyed by (device_id, seq).
-- This test owns its fixture and can run after the regional migrations.
SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '44444444-4444-4444-4444-444444444444';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '44444444-4444-4444-4444-444444444444',
    'ingress-a',
    'Ingress A',
    'active',
    'cn'
);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '44444444-4444-4444-4444-444444444444',
    '860000000000004',
    'ingress-device',
    'cn'
);

INSERT INTO app.ingress (
    device_id, seq, tenant_id, envelope_id, kind, payload
) VALUES (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    1,
    '44444444-4444-4444-4444-444444444444',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'SmsReceived',
    '{"modem_imei":"860000000000004","peer":"10086","body":"ok"}'::jsonb
);
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '44444444-4444-4444-4444-444444444444';

DO $$
BEGIN
    BEGIN
        INSERT INTO app.ingress (
            device_id, seq, tenant_id, envelope_id, kind, payload
        ) VALUES (
            'dddddddd-dddd-dddd-dddd-dddddddddddd',
            1,
            '44444444-4444-4444-4444-444444444444',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            'SmsReceived',
            '{"modem_imei":"860000000000004","peer":"10086","body":"other"}'::jsonb
        );
        RAISE EXCEPTION 'duplicate (device_id, seq) was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO app.ingress (
            device_id, seq, tenant_id, envelope_id, kind, payload
        ) VALUES (
            'dddddddd-dddd-dddd-dddd-dddddddddddd',
            0,
            '44444444-4444-4444-4444-444444444444',
            'cccccccc-cccc-cccc-cccc-cccccccccccc',
            'SmsReceived',
            '{"body":"zero"}'::jsonb
        );
        RAISE EXCEPTION 'seq 0 was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END
$$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '55555555-5555-5555-5555-555555555555';

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM app.ingress;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'tenant B unexpectedly read % tenant A ingress rows', v_count;
    END IF;
END
$$;
COMMIT;