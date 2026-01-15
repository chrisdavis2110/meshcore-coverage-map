#!/bin/bash
# Standard way to run docker-compose commands in this project
# Automatically loads server/.env for Docker Compose variable substitution
# Usage: ./docker-compose.sh [docker-compose arguments]
# Example: ./docker-compose.sh up -d --build
# Example: ./docker-compose.sh -f docker-compose.prod.yml up -d

if [ ! -f "server/.env" ]; then
    echo "Error: server/.env not found"
    echo "Please create server/.env from server/.env.example"
    exit 1
fi

# Safely load server/.env and export all variables for Docker Compose variable substitution
# Docker Compose variable substitution only reads from shell environment or root .env file
# We parse the file manually to avoid issues with values starting with dashes or containing special characters
set -a
while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    
    # Parse KEY=VALUE pairs
    if [[ "$line" =~ ^[[:space:]]*([^=[:space:]]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        # Remove any trailing comments from value
        value="${value%%#*}"
        # Trim trailing whitespace
        value="${value%"${value##*[![:space:]]}"}"
        # Export the variable safely
        export "${key}=${value}"
    fi
done < "server/.env"
set +a

# Run docker-compose with the environment variables loaded
exec docker-compose "$@"
