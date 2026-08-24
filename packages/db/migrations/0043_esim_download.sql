-- The console can now download a profile onto an eUICC.
--
-- This is the first command in the catalogue that writes to a card nobody can
-- physically reach. It installs a profile and it deliberately does not enable
-- one: SGP.22 keeps those apart, and the module on the bench has exactly one
-- working profile carrying traffic. The edge reads the Profile Policy Rules
-- out of the SM-DP+'s metadata before anything is written, and refuses rather
-- than installing a profile that could never be disabled or deleted.
--
-- app.commands.kind is an enum, so without this value the INSERT fails with a
-- type error that the gateway reports as "command queue unavailable" and a
-- 500. That reads like the queue is down rather than like a kind the database
-- has never heard of, which is a diagnosis that has cost this project an hour
-- before.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT. The statement is idempotent on
-- its own, which is what makes a re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'download_esim_profile';
