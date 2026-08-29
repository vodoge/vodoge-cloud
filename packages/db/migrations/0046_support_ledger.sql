-- What has actually been measured, on which module, on whose network.
--
-- The iron rule as a table: a pairing that is not a row here is not supported,
-- and the edge refuses it by name rather than trying it and finding out. A row
-- appears when somebody put hardware in front of a network and watched what
-- happened, which is why the evidence columns are not decoration -- `tested_at`
-- and `tested_by` are the difference between a measurement and an opinion, and
-- `note` is where the reading that justified the verdict goes.
--
-- Deliberately one row per (family, carrier) rather than a document per tenant.
-- `app.capability_matrix` already holds the document, and it stays: that is the
-- artefact pushed to devices, and it is *derived* from these rows. Keeping the
-- ledger as rows is what lets one pairing be re-tested, or one operator's
-- finding be read, without rewriting a blob.
--
-- The four support values match the edge's `BearerSupport`:
--
--   supported   measured working, over the named bearer
--   unsupported measured not working -- a real finding, and `reason` says why
--   probe       nobody has decided; the edge treats this as untested
--   (absent)    the operation was not part of this measurement
--
-- `probe` is admitted so a partial measurement can be recorded honestly, but
-- it grants nothing: the edge refuses a probe with "recorded as needing a
-- probe, which is not a measurement".
BEGIN;

CREATE TABLE IF NOT EXISTS app.support_ledger (
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    modem_family text NOT NULL,
    carrier text NOT NULL,
    sms_mo text,
    sms_mt text,
    data text,
    voice text,
    -- Which bearer the measurement was taken over. One column rather than four
    -- because a pairing that carries SMS over IMS and data over cellular is not
    -- something this bench has met, and inventing the shape for it now would be
    -- four columns nobody fills in.
    bearer text NOT NULL DEFAULT 'cellular',
    reason text,
    note text,
    tested_at timestamptz NOT NULL DEFAULT now(),
    tested_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, modem_family, carrier),
    CONSTRAINT support_ledger_family_shape
        CHECK (length(btrim(modem_family)) BETWEEN 1 AND 64),
    CONSTRAINT support_ledger_carrier_shape
        CHECK (length(btrim(carrier)) BETWEEN 1 AND 64),
    CONSTRAINT support_ledger_bearer_known
        CHECK (bearer IN ('cellular', 'ims')),
    CONSTRAINT support_ledger_values_known CHECK (
        (sms_mo IS NULL OR sms_mo IN ('supported', 'unsupported', 'probe')) AND
        (sms_mt IS NULL OR sms_mt IN ('supported', 'unsupported', 'probe')) AND
        (data IS NULL OR data IN ('supported', 'unsupported', 'probe')) AND
        (voice IS NULL OR voice IN ('supported', 'unsupported', 'probe'))
    ),
    -- A row that measured nothing is not a measurement.
    CONSTRAINT support_ledger_says_something CHECK (
        sms_mo IS NOT NULL OR sms_mt IS NOT NULL OR data IS NOT NULL OR voice IS NOT NULL
    ),
    CONSTRAINT support_ledger_tested_by_named
        CHECK (length(btrim(tested_by)) BETWEEN 1 AND 128)
);

ALTER TABLE app.support_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.support_ledger
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.support_ledger FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.support_ledger TO vodoge_app;
ALTER TABLE app.support_ledger OWNER TO vodoge_owner;

COMMENT ON TABLE app.support_ledger IS
    'Measured (modem family, carrier) pairings. A pairing absent from this table is refused by the edge as untested; the capability matrix pushed to devices is rendered from these rows.';

COMMIT;
