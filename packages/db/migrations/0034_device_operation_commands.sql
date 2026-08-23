-- The console can now ask a device to turn its data bearer on or off, change
-- which USB network function a module exposes, drop and retake a network
-- registration, and rescan for modules that are not in the inventory yet.
--
-- app.commands.kind is an enum, so without these values every one of those
-- commands is rejected at INSERT with a type error. The gateway reports that
-- as "command queue unavailable" and a 500, which reads like the queue is
-- down rather than like a kind the database has never heard of — worth
-- knowing when the next command type is added and the same 500 appears.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT. Each statement is idempotent on
-- its own, which is what makes a partial re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'set_data_network';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'set_usbnet_mode';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'reregister_network';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'refresh_modems';
