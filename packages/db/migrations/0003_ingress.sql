BEGIN;

-- Sequenced uplink journal. SMS uniqueness stays on app.messages(device_id, seq);
-- this table also covers CommandResult, DeviceState, EsimInventory, and Alert.
-- Duplicate (device_id, seq) with identical content is a no-op in the gateway
-- journal; a different envelope or payload is a conflict, not an update.
CREATE TABLE app.ingress (
    device_id uuid NOT NULL,
    seq bigint NOT NULL,
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingress_device_seq_key PRIMARY KEY (device_id, seq),
    CONSTRAINT ingress_envelope_id_key UNIQUE (envelope_id),
    CONSTRAINT ingress_device_tenant_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id),
    CONSTRAINT ingress_seq_positive CHECK (seq > 0),
    CONSTRAINT ingress_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX ingress_tenant_received_idx ON app.ingress (tenant_id, received_at DESC);

ALTER TABLE app.ingress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ingress FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.ingress
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.ingress FROM PUBLIC;
GRANT SELECT, INSERT ON app.ingress TO vodoge_app;

COMMIT;
