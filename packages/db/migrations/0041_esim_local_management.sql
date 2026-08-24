-- The console can now read an eUICC's own identity and state: the EID, what
-- GetEUICCInfo2 says about the chip, the notifications it still owes an
-- SM-DP+, and one of those notifications fetched whole.
--
-- Both are read-only against the card. Neither installs, enables, disables or
-- deletes anything.
--
-- app.commands.kind is an enum, so without these values both commands are
-- rejected at INSERT with a type error. The gateway reports that as
-- "command queue unavailable" and a 500, which reads like the queue is down
-- rather than like a kind the database has never heard of.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT. Each statement is idempotent on
-- its own, which is what makes a partial re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'read_esim_info';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'retrieve_esim_notification';
