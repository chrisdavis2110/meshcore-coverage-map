-- Add driver column to samples table to track who sent the ping

ALTER TABLE samples
  ADD COLUMN IF NOT EXISTS driver VARCHAR(255);

-- Create index for driver queries
CREATE INDEX IF NOT EXISTS idx_samples_driver ON samples (driver);
