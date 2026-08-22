BEGIN;

-- Nothing recorded which migrations had been applied.
--
-- They are applied by piping a file into psql, so the only evidence that
-- 0014 ran is that the columns it adds exist. That is enough to muddle
-- through day to day and useless in the one situation it matters: restoring
-- a dump and needing to know which migrations it already contains. Applying
-- one twice is mostly harmless here because the DDL is guarded, but applying
-- one that was missed is silent and leaves the schema subtly behind the code.
CREATE TABLE IF NOT EXISTS app.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    -- The file's checksum, so a migration edited after being applied is
    -- detectable. A changed file with the same number is the failure mode
    -- that ordinary version tracking misses entirely.
    sha256 text,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- Backfilled from what is demonstrably already in this database. No checksums
-- for these: the files may have been reformatted since, and recording a
-- checksum that was never verified would make the column lie from day one.
INSERT INTO app.schema_migrations (version, name, applied_at) VALUES
    (1,  '0001_regional_data',              '-infinity'),
    (2,  '0002_command_dispatch_lifecycle', '-infinity'),
    (3,  '0003_ingress',                    '-infinity'),
    (4,  '0004_accept_ingress',             '-infinity'),
    (5,  '0005_tenants',                    '-infinity'),
    (6,  '0006_enrollment',                 '-infinity'),
    (7,  '0007_rules_and_audit',            '-infinity'),
    (8,  '0008_project_ingress',            '-infinity'),
    (9,  '0009_capability_matrix',          '-infinity'),
    (10, '0010_console_auth',               '-infinity'),
    (11, '0011_resolver_role',              '-infinity'),
    (12, '0012_session_writes',             '-infinity'),
    (13, '0013_ingress_projection',         '-infinity'),
    (14, '0014_modem_networks',             '-infinity'),
    (15, '0015_relay_commands',             '-infinity'),
    (16, '0016_tenant_settings',            '-infinity'),
    (17, '0017_proxy',                      '-infinity'),
    (18, '0018_proxy_commands',             '-infinity'),
    (19, '0019_proxy_traffic_projection',   '-infinity')
ON CONFLICT (version) DO NOTHING;

INSERT INTO app.schema_migrations (version, name) VALUES (20, '0020_schema_migrations')
ON CONFLICT (version) DO NOTHING;

-- Readable by the application so a health check can report the schema it is
-- running against; only the migration runner writes it, as the owner.
REVOKE ALL ON app.schema_migrations FROM PUBLIC;
GRANT SELECT ON app.schema_migrations TO vodoge_app;
ALTER TABLE app.schema_migrations OWNER TO vodoge_owner;

COMMIT;
