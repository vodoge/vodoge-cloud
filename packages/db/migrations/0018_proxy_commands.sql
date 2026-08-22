-- app.commands.kind is an enum: without these values every proxy command is
-- rejected at INSERT with a type error rather than reaching a device.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration has no BEGIN/COMMIT. Each statement is idempotent on its own,
-- which is what makes a partial re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'configure_proxy';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'proxy_lifecycle';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'probe_upstream_proxy';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'rotate_ip';
