#!/usr/bin/env node

/**
 * Migration script to copy drivers from one server to another
 *
 * Fetches drivers from source URL and posts them to destination URL.
 *
 * Usage:
 *   node scripts/migrate-drivers.js
 *   node scripts/migrate-drivers.js --source <url> --dest <url>
 */

// Default URLs
const DEFAULT_SOURCE = 'https://source.domain.com/get-drivers';
const DEFAULT_DEST = 'http://dest.domain.com/put-driver';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    source: DEFAULT_SOURCE,
    dest: DEFAULT_DEST,
    delay: 0 // milliseconds between requests
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) {
      config.source = args[i + 1];
      i++;
    } else if (args[i] === '--dest' && args[i + 1]) {
      config.dest = args[i + 1];
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      config.delay = parseInt(args[i + 1], 10) || 0;
      i++;
    }
  }

  return config;
}

// Fetch drivers from source URL
async function fetchDrivers(sourceUrl) {
  console.log(`Fetching drivers from ${sourceUrl}...`);

  try {
    const response = await fetch(sourceUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.keys || !Array.isArray(data.keys)) {
      throw new Error('Invalid response format: expected { keys: [...] }');
    }

    console.log(`✓ Fetched ${data.keys.length} driver entries`);
    return data.keys;
  } catch (error) {
    console.error(`✗ Failed to fetch drivers: ${error.message}`);
    throw error;
  }
}

// Post a single driver entry to destination URL
async function postDriver(destUrl, driver) {
  const { metadata } = driver;

  // Extract driver data from metadata
  const { name, geohash, hit, miss } = metadata;

  // Validate required fields
  if (!name || !geohash) {
    throw new Error(`Missing required fields: name=${name}, geohash=${geohash}`);
  }

  // Build request body
  const body = {
    name: name,
    geohash: geohash,
    hit: hit || 0,
    miss: miss || 0
  };

  try {
    const response = await fetch(destUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }

    return true;
  } catch (error) {
    // Provide more detailed error information
    const errorDetails = error.cause ? ` (${error.cause.code || error.cause.message})` : '';
    const errorMessage = error.message || 'Unknown error';
    throw new Error(`Failed to post driver ${name} at ${geohash}: ${errorMessage}${errorDetails}`);
  }
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main migration function
async function migrate(config) {
  console.log('Starting driver migration...');
  console.log(`Source: ${config.source}`);
  console.log(`Destination: ${config.dest}`);
  if (config.delay > 0) {
    console.log(`Delay between requests: ${config.delay}ms`);
  }
  console.log('');

  // Fetch drivers
  let drivers;
  try {
    drivers = await fetchDrivers(config.source);
  } catch (error) {
    console.error('Migration failed: Could not fetch drivers');
    process.exit(1);
  }

  if (drivers.length === 0) {
    console.log('No driver entries to migrate.');
    return;
  }

  // Migrate each driver entry
  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i];
    const progress = `[${i + 1}/${drivers.length}]`;
    const driverName = driver.metadata?.name || 'unknown';
    const geohash = driver.metadata?.geohash || 'unknown';

    try {
      await postDriver(config.dest, driver);
      successCount++;

      if ((i + 1) % 100 === 0 || i === drivers.length - 1) {
        console.log(`${progress} Migrated ${successCount} driver entries (${errorCount} errors)`);
      }
    } catch (error) {
      errorCount++;
      errors.push({ driver: `${driverName}@${geohash}`, error: error.message });

      // Show error immediately for first few, then batch
      if (errorCount <= 10) {
        console.error(`${progress} ✗ ${error.message}`);
      }
    }

    // Add delay between requests if specified
    if (config.delay > 0 && i < drivers.length - 1) {
      await sleep(config.delay);
    }
  }

  // Print summary
  console.log('');
  console.log('Migration complete!');
  console.log(`  ✓ Successfully migrated: ${successCount}`);
  console.log(`  ✗ Failed: ${errorCount}`);

  if (errors.length > 0) {
    console.log('');
    console.log('Errors:');
    const displayErrors = errors.slice(0, 20); // Show first 20 errors
    displayErrors.forEach(({ driver, error }) => {
      console.log(`  ${driver}: ${error}`);
    });
    if (errors.length > 20) {
      console.log(`  ... and ${errors.length - 20} more errors`);
    }
  }

  if (errorCount > 0) {
    process.exit(1);
  }
}

// Run migration
const config = parseArgs();
migrate(config).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
