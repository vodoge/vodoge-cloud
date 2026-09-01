-- Adopting and unmanaging a module, in the enum the table stores.
--
-- 🔴 This is the second time. 0052 added six kinds for exactly the same
-- reason and wrote down exactly the same cause: the catalogue builds a valid
-- payload, the gateway validates it, and PostgreSQL rejects the enum value at
-- INSERT. The catalogue's tests build payloads and never store one, so nothing
-- in the Go test suite can see the gap -- it appears the first time somebody
-- issues the command, which on 2026-09-01 was during an end-to-end check of a
-- feature that had already been built, tested and deployed on both sides.
--
-- A guard belongs in the migrations CI job, which already has a database: read
-- `Kinds()` and assert every one is in `enum_range(NULL::app.command_kind)`.
-- Until that exists, adding a command means remembering this file.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so there is
-- no BEGIN/COMMIT here, matching 0034/0042/0043/0052. Each statement is
-- idempotent on its own, which is what makes a re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'register_modem';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'unregister_modem';
