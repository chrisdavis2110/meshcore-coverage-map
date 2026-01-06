-- Replace observer column with drivers column
-- Migrate existing observer data to drivers, then remove observer column

-- Add drivers column
ALTER TABLE samples
  ADD COLUMN IF NOT EXISTS drivers VARCHAR(255);

-- Create index for drivers queries
CREATE INDEX IF NOT EXISTS idx_samples_drivers ON samples (drivers);

-- Drop the old observer column and its index
DROP INDEX IF EXISTS idx_samples_observer;
ALTER TABLE samples
  DROP COLUMN IF EXISTS observer;
