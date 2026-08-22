BEGIN;

-- Proxy configuration, as the cloud holds it.
--
-- The proxies themselves run on the edge: a listener bound to one modem's
-- network interface, so traffic through it leaves over that SIM. That is the
-- whole point of the feature and it cannot be done from the cloud, which has
-- no cellular interface to bind to.
--
-- So these tables are desired state. The cloud stores what should be running,
-- pushes it to the device, and shows what the device reports back. A row here
-- is an intention, never an observation — the two are kept apart because a
-- listener that failed to bind must not look identical to one that was never
-- configured.

CREATE TABLE app.upstream_proxies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    -- host:port. Stored as one field because that is how it is configured,
    -- entered, and probed; splitting it invites the two halves to disagree.
    address text NOT NULL,
    protocol text NOT NULL DEFAULT 'socks5',
    username text,
    -- Written by the console, never returned to it.
    password text,
    enabled boolean NOT NULL DEFAULT true,
    -- The last probe the edge ran, verbatim. A probe is a diagnostic, so its
    -- shape belongs to whoever ran it rather than to this schema.
    last_probe jsonb,
    last_probe_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT upstream_proxies_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    CONSTRAINT upstream_proxies_tenant_name_key UNIQUE (tenant_id, name),
    CONSTRAINT upstream_proxies_protocol_known
        CHECK (protocol IN ('socks5', 'http')),
    CONSTRAINT upstream_proxies_probe_is_object
        CHECK (last_probe IS NULL OR jsonb_typeof(last_probe) = 'object')
);

CREATE TABLE app.proxy_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    name text NOT NULL,
    -- Which module's interface the listener binds to. IMEI rather than a row
    -- id: it is the only stable handle for a physical module, and it survives
    -- the modem being re-enumerated.
    modem_imei text NOT NULL,
    protocol text NOT NULL DEFAULT 'socks5',
    listen_addr text NOT NULL DEFAULT '0.0.0.0',
    listen_port integer NOT NULL,
    auth_enabled boolean NOT NULL DEFAULT false,
    username text,
    password text,
    -- Chain through this upstream when set. NULL means straight out over the
    -- cellular interface.
    upstream_id uuid,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT proxy_instances_device_fkey
        FOREIGN KEY (tenant_id, device_id) REFERENCES app.devices (tenant_id, id),
    CONSTRAINT proxy_instances_upstream_fkey
        FOREIGN KEY (upstream_id) REFERENCES app.upstream_proxies (id) ON DELETE SET NULL,
    CONSTRAINT proxy_instances_tenant_name_key UNIQUE (tenant_id, name),
    -- One listener per port per device. Two instances on the same port is a
    -- configuration that can only ever half work.
    CONSTRAINT proxy_instances_device_port_key UNIQUE (tenant_id, device_id, listen_port),
    CONSTRAINT proxy_instances_protocol_known CHECK (protocol IN ('socks5', 'http')),
    CONSTRAINT proxy_instances_port_valid CHECK (listen_port BETWEEN 1 AND 65535)
);

-- Which upstream to use for a card from a given country.
--
-- Keyed by ISO country code because that is what an operator reasons about;
-- the edge maps a card's MCC to a country before consulting this.
CREATE TABLE app.upstream_proxy_country_rules (
    tenant_id uuid NOT NULL,
    country_code text NOT NULL,
    upstream_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, country_code),
    CONSTRAINT upstream_country_rules_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    CONSTRAINT upstream_country_rules_upstream_fkey
        FOREIGN KEY (upstream_id) REFERENCES app.upstream_proxies (id) ON DELETE CASCADE,
    CONSTRAINT upstream_country_rules_code_shape
        CHECK (country_code ~ '^[A-Z]{2}$')
);

-- Traffic as the edge accounts for it, one row per instance per hour.
--
-- Hourly rather than per connection: a busy proxy would otherwise write more
-- rows than the data is worth, and no question anyone asks of this needs
-- finer resolution than an hour.
CREATE TABLE app.proxy_traffic (
    tenant_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    hour timestamptz NOT NULL,
    bytes_up bigint NOT NULL DEFAULT 0,
    bytes_down bigint NOT NULL DEFAULT 0,
    connections bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, instance_id, hour),
    CONSTRAINT proxy_traffic_instance_fkey
        FOREIGN KEY (instance_id) REFERENCES app.proxy_instances (id) ON DELETE CASCADE,
    CONSTRAINT proxy_traffic_hour_is_whole
        CHECK (hour = date_trunc('hour', hour))
);

CREATE INDEX proxy_traffic_tenant_hour_idx ON app.proxy_traffic (tenant_id, hour DESC);
CREATE INDEX proxy_instances_device_idx ON app.proxy_instances (tenant_id, device_id);

ALTER TABLE app.upstream_proxies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.upstream_proxies FORCE ROW LEVEL SECURITY;
ALTER TABLE app.proxy_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.proxy_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE app.upstream_proxy_country_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.upstream_proxy_country_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.proxy_traffic ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.proxy_traffic FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.upstream_proxies
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.proxy_instances
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.upstream_proxy_country_rules
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON app.proxy_traffic
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.upstream_proxies FROM PUBLIC;
REVOKE ALL ON app.proxy_instances FROM PUBLIC;
REVOKE ALL ON app.upstream_proxy_country_rules FROM PUBLIC;
REVOKE ALL ON app.proxy_traffic FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.upstream_proxies TO vodoge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.proxy_instances TO vodoge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.upstream_proxy_country_rules TO vodoge_app;
GRANT SELECT, INSERT, UPDATE ON app.proxy_traffic TO vodoge_app;

ALTER TABLE app.upstream_proxies OWNER TO vodoge_owner;
ALTER TABLE app.proxy_instances OWNER TO vodoge_owner;
ALTER TABLE app.upstream_proxy_country_rules OWNER TO vodoge_owner;
ALTER TABLE app.proxy_traffic OWNER TO vodoge_owner;

COMMIT;
