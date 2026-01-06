-- Add pubkey column to repeaters table to store full 32-byte public key (64 hex chars)

ALTER TABLE repeaters
  ADD COLUMN IF NOT EXISTS pubkey VARCHAR(64);

-- Create index for pubkey lookups
CREATE INDEX IF NOT EXISTS idx_repeaters_pubkey ON repeaters (pubkey);

-- Update existing rows: derive pubkey from id (first 2 chars) by padding with zeros
-- This is a temporary measure - ideally existing data would have full pubkeys
-- For now, we'll use id as a prefix and pad the rest
UPDATE repeaters
SET pubkey = LOWER(id) || REPEAT('0', 62)
WHERE pubkey IS NULL;
