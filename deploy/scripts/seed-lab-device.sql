\set ON_ERROR_STOP on

BEGIN;
SET LOCAL app.tenant_id = 'a0000000-0000-4000-8000-00000000000a';

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'b0000000-0000-4000-8000-00000000000b',
    'a0000000-0000-4000-8000-00000000000a',
    'lab-edge-vodoge',
    'lab-ec25',
    'cn'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
