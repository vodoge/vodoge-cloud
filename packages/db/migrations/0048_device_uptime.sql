-- How much of each hour a device was reachable.
--
-- The console could say whether a device is online now and nothing about
-- whether it has been, and those answer different questions: "it is connected"
-- is a fact about this second, while "it has been connected all week" is what
-- decides whether a stick is worth giving a job to.
--
-- One row per device per hour, holding the count of minutes in which at least
-- one frame arrived. Not one row per sighting: a device heartbeats every
-- thirty seconds, so sightings would be a few hundred thousand rows a day per
-- device to answer a question about ratios. The counting happens in Redis as a
-- sixty-bit map -- see internal/uptime -- and this table is where the count
-- lands once the hour is closed.
--
-- `minutes_online` is out of 60 and that denominator is deliberate rather than
-- stored: an hour is an hour. What it does NOT say is whether the device was
-- expected to be up -- a stick enrolled at twenty past its first hour reports
-- 40, and reads as 67% for an hour it only existed for two thirds of. The
-- console draws ratios over hours that have rows, so an hour a device did not
-- exist in is absent rather than zero.
--
-- An hour in which nothing was heard has no row at all. That is the same shape
-- as "absent", and it is correct: writing a zero for every device every hour
-- would fill the table with the absence of information, and a gap already
-- reads as a gap.
BEGIN;

CREATE TABLE IF NOT EXISTS app.device_uptime (
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    device_id uuid NOT NULL REFERENCES app.devices (id) ON DELETE CASCADE,
    -- Truncated to the hour, UTC. The uniqueness of (device, hour) is what
    -- makes a double flush harmless if one ever happens.
    hour timestamptz NOT NULL,
    minutes_online smallint NOT NULL,
    written_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, device_id, hour),
    CONSTRAINT device_uptime_minutes_in_an_hour
        CHECK (minutes_online BETWEEN 0 AND 60),
    CONSTRAINT device_uptime_hour_is_truncated
        CHECK (hour = date_trunc('hour', hour))
);

-- The console's query is "this device, recent hours, newest first".
CREATE INDEX IF NOT EXISTS device_uptime_by_device
    ON app.device_uptime (tenant_id, device_id, hour DESC);

ALTER TABLE app.device_uptime ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.device_uptime FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.device_uptime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.device_uptime FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.device_uptime TO vodoge_app;
ALTER TABLE app.device_uptime OWNER TO vodoge_owner;

COMMENT ON TABLE app.device_uptime IS
    'Minutes per hour in which a device was heard from. Counted in Redis as a bitmap and flushed here when the hour closes; an hour with no row is an hour nothing was heard.';

COMMIT;
