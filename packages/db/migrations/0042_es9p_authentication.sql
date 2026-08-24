-- The console can now start an ES9+ session with a real SM-DP+.
--
-- InitiateAuthentication is the one ES9+ function that needs no activation
-- code and has no effect on an account: it hands the server a challenge the
-- eUICC generated moments earlier and gets back a signed answer. Nothing is
-- written to the card and no notification is delivered, so this stays a read
-- for the same reason read_esim_info does.
--
-- app.commands.kind is an enum, so without this value the command is rejected
-- at INSERT with a type error. The gateway reports that as "command queue
-- unavailable" and a 500, which reads like the queue is down rather than like
-- a kind the database has never heard of.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT. The statement is idempotent on
-- its own, which is what makes a re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'initiate_esim_authentication';
