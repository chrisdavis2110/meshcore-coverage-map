#!/bin/bash
# Run all database migrations in order
# This script applies all migrations that may not have been run yet

set -e

# Get database connection info from environment or use defaults
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_USER=${DB_USER:-meshmap}
DB_NAME=${DB_NAME:-meshmap}

echo "Running all database migrations..."
echo "Database: $DB_NAME@$DB_HOST:$DB_PORT"

# Run migrations in order
MIGRATIONS=(
  "001_initial_schema.sql"
  "002_fix_elevation_type.sql"
  "003_increase_lat_lon_precision.sql"
  "004_add_observed_snr_rssi.sql"
  "005_add_repeater_pubkey.sql"
  "006_add_sample_observer.sql"
)

for migration in "${MIGRATIONS[@]}"; do
  if [ -f "migrations/$migration" ]; then
    echo "Running migration: $migration"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "migrations/$migration" || {
      echo "Warning: Migration $migration failed (may already be applied)"
    }
  else
    echo "Warning: Migration file $migration not found, skipping"
  fi
done

echo "Migration check complete!"
