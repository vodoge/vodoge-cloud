BEGIN;

-- Every device says what it is running and how far behind it is, on every
-- Resume: edge_version, capability_matrix_version, and the depth of its
-- outbound queue in records and bytes. None of it was kept.
--
-- Which means the two questions an operator asks about a fleet — what is still
-- on the old build, and what is backing up — could only be answered by reading
-- gateway logs.
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS edge_version text;
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS matrix_version text;
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS queue_records bigint;
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS queue_bytes bigint;
-- When the device last established a session, which is a different fact from
-- last_seen_at: a device can be sending data on a session opened days ago.
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

-- "Which devices are on the old build" is a fleet-wide question, so it is
-- worth an index even on a small table.
CREATE INDEX IF NOT EXISTS devices_tenant_version_idx
    ON app.devices (tenant_id, edge_version);

-- Recording this happens on the uplink, where the gateway holds no tenant
-- context of its own — the session's device is the authority. SECURITY
-- DEFINER for the same reason app.delete_device is, and isolation still
-- applies: the owner is subject to FORCE row level security.
CREATE OR REPLACE FUNCTION app.record_device_resume(
    p_tenant_id uuid,
    p_device_id uuid,
    p_edge_version text,
    p_matrix_version text,
    p_queue_records bigint,
    p_queue_bytes bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
    UPDATE app.devices
       SET edge_version = coalesce(nullif(p_edge_version, ''), edge_version),
           matrix_version = coalesce(nullif(p_matrix_version, ''), matrix_version),
           -- Queue depth is replaced rather than coalesced: zero is the
           -- answer that matters most, and treating it as "no news" would
           -- leave a drained device looking permanently backed up.
           queue_records = p_queue_records,
           queue_bytes = p_queue_bytes,
           resumed_at = now(),
           updated_at = now()
     WHERE tenant_id = p_tenant_id
       AND id = p_device_id;
END
$$;

ALTER FUNCTION app.record_device_resume(uuid, uuid, text, text, bigint, bigint)
    OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.record_device_resume(uuid, uuid, text, text, bigint, bigint)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_device_resume(uuid, uuid, text, text, bigint, bigint)
    TO vodoge_app;

INSERT INTO app.schema_migrations (version, name) VALUES (25, '0025_device_health')
ON CONFLICT (version) DO NOTHING;

COMMIT;
