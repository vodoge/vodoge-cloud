-- How many devices a tenant may enrol.
--
-- Enrolment is self-service by design: a device presents a certificate and
-- registers itself, which is what makes bringing a new edge machine online a
-- matter of installing the agent. The same property means nothing bounds how
-- many a tenant can bring, and one tenant filling the fleet is a failure the
-- other tenants experience.
--
-- NULL is not "zero" and not "unset waiting for a value": it is explicitly
-- unlimited, which is what every tenant is today and what this table must keep
-- them as until somebody decides otherwise. A default of any number here would
-- silently cap every existing tenant at it.
BEGIN;

ALTER TABLE app.tenants ADD COLUMN IF NOT EXISTS device_quota integer;

ALTER TABLE app.tenants
    ADD CONSTRAINT tenants_device_quota_positive
    CHECK (device_quota IS NULL OR device_quota > 0);

COMMENT ON COLUMN app.tenants.device_quota IS
    'Most devices this tenant may have enrolled. NULL is unlimited, which is what a tenant with no explicit decision is; the enrolment path refuses a registration that would exceed it.';

COMMIT;
