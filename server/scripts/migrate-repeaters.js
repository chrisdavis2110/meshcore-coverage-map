#!/usr/bin/env node

/**
 * Migration script to copy repeaters from one server to another
 *
 * Fetches repeaters from source URL and posts them to destination URL.
 *
 * Usage:
 *   node scripts/migrate-repeaters.js
 *   node scripts/migrate-repeaters.js --source <url> --dest <url>
 */

// Default URLs - MUST be overridden via command line arguments
// Using placeholder URLs to prevent accidental migrations
const DEFAULT_SOURCE = 'https://source.example.com/get-repeaters';
const DEFAULT_DEST = 'https://dest.example.com/put-repeater';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    source: DEFAULT_SOURCE,
    dest: DEFAULT_DEST,
    delay: 10 // milliseconds between requests
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

// Fetch repeaters from source URL
async function fetchRepeaters(sourceUrl) {
  console.log(`Fetching repeaters from ${sourceUrl}...`);

  try {
    const response = await fetch(sourceUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.keys || !Array.isArray(data.keys)) {
      throw new Error('Invalid response format: expected { keys: [...] }');
    }

    console.log(`✓ Fetched ${data.keys.length} repeaters`);
    return data.keys;
  } catch (error) {
    console.error(`✗ Failed to fetch repeaters: ${error.message}`);
    throw error;
  }
}

// Post a single repeater to destination URL
async function postRepeater(destUrl, repeater) {
  const { metadata } = repeater;

  // Extract repeater data from metadata
  const { id, name, lat, lon } = metadata;

  // Validate required fields
  if (!id || lat === undefined || lon === undefined) {
    throw new Error(`Missing required fields: id=${id}, lat=${lat}, lon=${lon}`);
  }

  // Build request body
  const body = {
    id: id,
    name: name || '',
    lat: lat,
    lon: lon
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
    throw new Error(`Failed to post repeater ${id} (${lat},${lon}): ${error.message}`);
  }
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main migration function
async function migrate(config) {
  // Validate that URLs are not placeholders
  if (config.source.includes('example.com') || config.dest.includes('example.com')) {
    console.error('ERROR: Default placeholder URLs detected!');
    console.error('You must provide --source and --dest arguments.');
    console.error('');
    console.error('Usage:');
    console.error('  node scripts/migrate-repeaters.js --source <url> --dest <url>');
    console.error('');
    console.error('Example:');
    console.error('  node scripts/migrate-repeaters.js --source http://localhost:3000/get-repeaters --dest https://coverage.stonekitty.net/put-repeater');
    process.exit(1);
  }

  console.log('Starting repeater migration...');
  console.log(`Source: ${config.source}`);
  console.log(`Destination: ${config.dest}`);
  if (config.delay > 0) {
    console.log(`Delay between requests: ${config.delay}ms`);
  }
  console.log('');

  // Fetch repeaters
  let repeaters;
  try {
    repeaters = await fetchRepeaters(config.source);
  } catch (error) {
    console.error('Migration failed: Could not fetch repeaters');
    process.exit(1);
  }

  if (repeaters.length === 0) {
    console.log('No repeaters to migrate.');
    return;
  }

  // Migrate each repeater
  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 0; i < repeaters.length; i++) {
    const repeater = repeaters[i];
    const progress = `[${i + 1}/${repeaters.length}]`;
    const repeaterId = repeater.metadata?.id || 'unknown';

    try {
      await postRepeater(config.dest, repeater);
      successCount++;

      if ((i + 1) % 50 === 0 || i === repeaters.length - 1) {
        console.log(`${progress} Migrated ${successCount} repeaters (${errorCount} errors)`);
      }
    } catch (error) {
      errorCount++;
      errors.push({ repeater: repeaterId, error: error.message });

      // Show error immediately for first few, then batch
      if (errorCount <= 10) {
        console.error(`${progress} ✗ ${error.message}`);
      }
    }

    // Add delay between requests if specified
    if (config.delay > 0 && i < repeaters.length - 1) {
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
    displayErrors.forEach(({ repeater, error }) => {
      console.log(`  ${repeater}: ${error}`);
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
