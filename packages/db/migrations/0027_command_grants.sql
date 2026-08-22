BEGIN;

-- The command relay has never worked on any deployment.
--
-- PendingForDevice — the query that decides what to hand a device — joins
-- app.command_outbox for the attempt count, and vodoge_app was never granted
-- SELECT on it. The query failed with "permission denied" every time, and the
-- caller discards the error, so every command ever issued sat in `queued`
-- forever while the device stayed connected and healthy.
--
-- Nothing surfaced it because a queued command looks exactly like a command
-- waiting for a device that has not reconnected yet.
--
-- Writes in this schema go through SECURITY DEFINER functions and reads go
-- direct, which is why enqueueing worked and delivery did not: enqueue_command
-- is a function, PendingForDevice is a query.
GRANT SELECT ON app.command_outbox TO vodoge_app;

-- The lifecycle writes that were never exercised, because no command was ever
-- delivered and so no receipt or result ever came back. Each would have failed
-- the same way the moment one did.
GRANT UPDATE ON app.command_outbox TO vodoge_app;
GRANT UPDATE ON app.commands TO vodoge_app;
GRANT INSERT ON app.command_receipts TO vodoge_app;

INSERT INTO app.schema_migrations (version, name) VALUES (27, '0027_command_grants')
ON CONFLICT (version) DO NOTHING;

COMMIT;
