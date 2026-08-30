-- The device quota moves out of app.tenants and into the tenant's settings.
--
-- 0049 put it on the tenants table. That was the wrong home: every other piece
-- of console-editable tenant configuration is a section in app.tenant_settings,
-- and a limit in a column of its own would have needed its own endpoint, its
-- own form, and its own validation path beside the one that already exists for
-- exactly this. `settings.validateDevices` is where its bounds live now.
--
-- Dropped rather than left in place unused. A column two things could read is
-- how a limit ends up enforced from one place and edited in another; nothing
-- has written this one, so nothing is lost by removing it.
BEGIN;

ALTER TABLE app.tenants DROP CONSTRAINT IF EXISTS tenants_device_quota_positive;
ALTER TABLE app.tenants DROP COLUMN IF EXISTS device_quota;

COMMIT;
