-- What an operator says a card's plan is sold as doing.
--
-- The layer that separates two cards nothing else can tell apart. On this
-- bench a Club profile receives and cannot send, while a Webbing profile on
-- the same Hong Kong network in the same EC20 does both: same module family,
-- same carrier profile, same everything the hardware or the network can be
-- asked. The difference is what was bought, and the only way it arrives is
-- somebody typing it in.
--
-- Three states per operation, hence nullable with no default:
--
--   NULL  nobody has said
--   false this plan does not include it  -- the only value that changes anything
--   true  it does                        -- asserts nothing on its own
--
-- The asymmetry is deliberate and enforced on the edge: a declaration is
-- strictly subtractive. It can withhold an operation the measured (module,
-- carrier) pair allowed; it can never grant one that pair was not measured to
-- have. A tariff read off a website is not a measurement, and the worst
-- outcome available is a console claiming a stick does something nobody has
-- ever seen it do.
BEGIN;

ALTER TABLE app.card_policies ADD COLUMN IF NOT EXISTS sms_send boolean;
ALTER TABLE app.card_policies ADD COLUMN IF NOT EXISTS sms_receive boolean;
ALTER TABLE app.card_policies ADD COLUMN IF NOT EXISTS data boolean;
ALTER TABLE app.card_policies ADD COLUMN IF NOT EXISTS voice boolean;

COMMENT ON COLUMN app.card_policies.sms_send IS
    'Subscription declaration, strictly subtractive: false withholds sending on this card, true asserts nothing, NULL is undeclared. Never grants a capability the measured (modem, carrier) pair lacks.';

COMMIT;
