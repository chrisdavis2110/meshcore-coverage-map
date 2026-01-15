-- Add region column to repeaters table to support multiple regions/networks
-- This allows distinguishing repeaters with the same ID across different regions

ALTER TABLE repeaters
  ADD COLUMN IF NOT EXISTS region VARCHAR(255);

-- Create index for region queries
CREATE INDEX IF NOT EXISTS idx_repeaters_region ON repeaters (region);

-- Set default region for existing repeaters (can be updated later)
-- Using NULL as default allows backward compatibility
UPDATE repeaters
SET region = NULL
WHERE region IS NULL;
