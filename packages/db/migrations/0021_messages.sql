BEGIN;

-- Two things about app.messages that only a real SMS would have exposed.
--
-- First, the bearer CHECK and the contract disagreed. The table allowed
-- 'cellular', 'ims', 'sgs'; the contract declares 'cs', 'ims', 'nas',
-- 'unknown'. The projection defaults an absent bearer to 'unknown', which the
-- CHECK would have rejected — taking the whole ingress transaction with it and
-- losing the envelope, the one thing the journal exists to prevent. The table
-- is empty, so this is a straight replacement rather than a migration of data.
ALTER TABLE app.messages DROP CONSTRAINT IF EXISTS messages_bearer_valid;
UPDATE app.messages SET bearer = CASE bearer
    WHEN 'cellular' THEN 'unknown'   -- never a delivery path, only a radio
    WHEN 'sgs' THEN 'nas'            -- SGs is how CS-fallback SMS arrives on LTE
    ELSE bearer END
 WHERE bearer NOT IN ('cs', 'ims', 'nas', 'unknown');
ALTER TABLE app.messages ADD CONSTRAINT messages_bearer_valid
    CHECK (bearer IN ('cs', 'ims', 'nas', 'unknown'));

-- Second, a sent message was recorded nowhere. Sending goes through the
-- command queue, so the only evidence a message was ever sent lived in
-- app.commands as a payload — which means the console could show a
-- conversation with half of it missing, and could not answer "did it arrive".
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS command_id uuid;
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS failure_reason text;

-- Inbound messages arrived; there is nothing to wait for.
UPDATE app.messages SET status = 'received' WHERE status IS NULL AND direction = 'inbound';
UPDATE app.messages SET status = 'sent' WHERE status IS NULL;

ALTER TABLE app.messages ALTER COLUMN status SET NOT NULL;
ALTER TABLE app.messages ADD CONSTRAINT messages_status_valid
    CHECK (status IN ('received', 'queued', 'sent', 'failed'));

-- An outbound message and its command are the same event seen twice, so the
-- link is unique. Partial, because inbound messages have no command.
CREATE UNIQUE INDEX IF NOT EXISTS messages_command_key
    ON app.messages (command_id) WHERE command_id IS NOT NULL;

-- The seq uniqueness was designed for the inbound journal, where the device
-- assigns it. An outbound message has no journal sequence, so it cannot share
-- that constraint — two sends would collide on seq 0.
ALTER TABLE app.messages DROP CONSTRAINT IF EXISTS messages_device_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_device_seq_key
    ON app.messages (device_id, seq) WHERE direction = 'inbound';

-- The console lists conversations newest first and opens one at a time.
CREATE INDEX IF NOT EXISTS messages_tenant_peer_idx
    ON app.messages (tenant_id, peer, received_at DESC);

INSERT INTO app.schema_migrations (version, name) VALUES (21, '0021_messages')
ON CONFLICT (version) DO NOTHING;

COMMIT;
