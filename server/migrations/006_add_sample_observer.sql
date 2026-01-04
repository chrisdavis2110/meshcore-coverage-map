-- Add observer column to samples table to track who sent the ping

ALTER TABLE samples
  ADD COLUMN IF NOT EXISTS observer VARCHAR(255);

-- Create index for observer queries
CREATE INDEX IF NOT EXISTS idx_samples_observer ON samples (observer);
