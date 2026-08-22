-- The command kind must exist in the enum or every policy push fails at
-- INSERT. No transaction block: ALTER TYPE ... ADD VALUE is refused inside one.
ALTER TYPE app.command_kind ADD VALUE IF NOT EXISTS 'update_card_policy';
