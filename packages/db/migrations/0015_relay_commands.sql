-- The console can now ask a device to do everything the edge panel could do
-- locally: run an AT command, send USSD, toggle the radio, scan and select an
-- operator, pull a diagnostic report, reset the USB link, and list or switch
-- eSIM profiles.
--
-- app.commands.kind is an enum, so without these values every one of those
-- commands is rejected at INSERT with a type error rather than reaching a
-- device.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this
-- migration deliberately has no BEGIN/COMMIT. Each statement is idempotent on
-- its own, which is what makes a partial re-run safe.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'run_at_command';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'send_ussd';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'set_radio';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'scan_operators';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'select_operator';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'modem_report';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'reset_modem_usb';
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'list_esim_profiles';

-- The device page lists a device's recent commands newest first. Without this
-- that is a sequential scan of every command the tenant has ever issued.
CREATE INDEX IF NOT EXISTS commands_device_issued_idx
    ON app.commands (tenant_id, device_id, issued_at DESC);
