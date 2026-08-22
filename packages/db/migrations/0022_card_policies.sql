BEGIN;

-- Per-card policy: whether the card may use cellular data, which vertical's
-- rules apply to it, and which APN to use.
--
-- The command to push these has existed in the contract since the beginning
-- and nothing ever sent one, because there was nowhere to write a policy down.
--
-- Keyed by ICCID rather than by modem: a policy belongs to the subscription,
-- not to the hardware it happens to be in today. Moving a SIM to another stick
-- should carry its policy with it, and on an eUICC the ICCID is what changes
-- when a profile is switched — which is exactly when a different policy should
-- take effect.
CREATE TABLE app.card_policies (
    tenant_id uuid NOT NULL,
    iccid text NOT NULL,
    cellular_enabled boolean NOT NULL DEFAULT true,
    vertical text NOT NULL DEFAULT 'cn',
    apn text,
    note text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, iccid),
    CONSTRAINT card_policies_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    -- Matches the contract's Iccid pattern. A policy for something that is not
    -- an ICCID would be pushed to every device and match no card on any of
    -- them, which is a silent no-op rather than an error.
    CONSTRAINT card_policies_iccid_shape CHECK (iccid ~ '^[0-9]{19,20}$'),
    CONSTRAINT card_policies_vertical_known CHECK (vertical IN ('cn', 'intl')),
    CONSTRAINT card_policies_apn_length CHECK (apn IS NULL OR length(apn) BETWEEN 1 AND 128)
);

ALTER TABLE app.card_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.card_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.card_policies
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.card_policies FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.card_policies TO vodoge_app;
ALTER TABLE app.card_policies OWNER TO vodoge_owner;

INSERT INTO app.schema_migrations (version, name) VALUES (22, '0022_card_policies')
ON CONFLICT (version) DO NOTHING;

COMMIT;
