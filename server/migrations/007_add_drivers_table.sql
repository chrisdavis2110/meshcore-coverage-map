-- Add drivers table to track driver coverage statistics by geohash tile

CREATE TABLE IF NOT EXISTS drivers (
    name VARCHAR(255) NOT NULL,
    geohash VARCHAR(6) NOT NULL,
    hit INTEGER DEFAULT 0,
    miss INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name, geohash)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_drivers_name ON drivers (name);
CREATE INDEX IF NOT EXISTS idx_drivers_geohash ON drivers (geohash);
CREATE INDEX IF NOT EXISTS idx_drivers_name_geohash ON drivers (name, geohash);

-- Trigger to auto-update updated_at
CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
