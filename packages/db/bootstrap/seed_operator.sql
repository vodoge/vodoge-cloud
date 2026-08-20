\set ON_ERROR_STOP on

-- First-party tenant: a.vodoge.com. FORCE RLS still applies to the owner, so
-- SET LOCAL is required. Re-running is a no-op.
BEGIN;
SET LOCAL app.tenant_id = 'a0000000-0000-4000-8000-00000000000a';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    'a0000000-0000-4000-8000-00000000000a',
    'a',
    'VoDoge',
    'active',
    'cn'
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
