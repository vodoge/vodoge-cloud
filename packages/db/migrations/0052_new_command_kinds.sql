-- The six command kinds added on 2026-08-30, in the enum the table stores.
--
-- 🔴 Every one of them would otherwise have been refused at INSERT: the
-- catalogue built a valid payload, the gateway validated it, and PostgreSQL
-- rejected the enum value. Nothing reached the edge, and the failure appeared
-- only when a command was actually issued -- the catalogue's own tests build
-- payloads and never store them, so the gap was invisible to them.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT, matching 0034/0042/0043. Each
-- statement is idempotent on its own, which is what makes a re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'read_logs';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'configure_apn';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'claim_modem_candidate';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'rename_esim_profile';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'disable_esim_profile';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'delete_esim_profile';
