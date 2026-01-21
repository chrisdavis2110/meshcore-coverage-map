#!/bin/bash
# Database initialization script for Docker
# This script waits for PostgreSQL to be ready and runs migrations

set -e

echo "Waiting for PostgreSQL to be ready..."
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER"; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is up - executing migrations"

# Run all migrations in order
MIGRATIONS=(
  "001_initial_schema.sql"
  "002_fix_elevation_type.sql"
  "003_increase_lat_lon_precision.sql"
  "004_add_observed_snr_rssi.sql"
  "005_add_repeater_pubkey.sql"
  "006_add_sample_observer.sql"
  "007_replace_observer_with_drivers.sql"
)

for migration in "${MIGRATIONS[@]}"; do
  if [ -f "/app/migrations/$migration" ]; then
    echo "Running migration: $migration"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "/app/migrations/$migration" || {
      echo "Warning: Migration $migration failed (may already be applied)"
    }
  fi
done

echo "Database initialization complete!"
