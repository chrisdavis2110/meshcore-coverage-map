/**
 * Script to remove MQTT observer data from samples table
 *
 * This script can work in two modes:
 * 1. Automatic detection: Finds observers with NO samples with signal data (snr/rssi)
 * 2. Manual specification: Remove specific observer names you provide
 *
 * The script will set observer = NULL for all samples from identified
 * MQTT observers, effectively removing them from the "Top Drivers" list.
 *
 * Usage:
 *   # Automatic detection mode
 *   node scripts/remove-mqtt-observers.js [--dry-run] [--confirm]
 *
 *   # Manual specification mode
 *   node scripts/remove-mqtt-observers.js --observers "Observer1" "Observer2" [--dry-run] [--confirm]
 *
 * Options:
 *   --observers: Specify observer names to remove (space-separated, quoted)
 *   --dry-run: Show what would be changed without making changes (default)
 *   --confirm: Actually perform the update
 *
 * Examples:
 *   # Automatic detection (finds observers with no signal data)
 *   node scripts/remove-mqtt-observers.js --dry-run
 *   node scripts/remove-mqtt-observers.js --confirm
 *
 *   # Remove specific observers
 *   node scripts/remove-mqtt-observers.js --observers "OHMC Repeater" "Nullrouten observer" --dry-run
 *   node scripts/remove-mqtt-observers.js --observers "OHMC Repeater" "Nullrouten observer" --confirm
 *
 *   # Docker container
 *   docker-compose exec app node scripts/remove-mqtt-observers.js --observers "Observer Name" --dry-run
 *   docker-compose exec app node scripts/remove-mqtt-observers.js --observers "Observer Name" --confirm
 */

require('dotenv').config();
const pool = require('../src/config/database');

async function removeMqttObservers(dryRun = true, specifiedObservers = null) {
  const client = await pool.connect();

  try {
    // First, check if observer column exists
    const columnCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'samples' AND column_name = 'observer'
    `);

    if (columnCheck.rows.length === 0) {
      console.log('Observer column does not exist. Nothing to do.');
      return;
    }

    let observersToRemove = [];

    if (specifiedObservers && specifiedObservers.length > 0) {
      // Manual mode: use specified observer names
      console.log(`\nManual mode: Removing ${specifiedObservers.length} specified observer(s):`);
      specifiedObservers.forEach(obs => console.log(`  - ${obs}`));

      // Verify these observers exist and get their sample counts
      const placeholders = specifiedObservers.map((_, i) => `$${i + 1}`).join(', ');
      const verifyQuery = `
        SELECT
          observer,
          COUNT(*) as total_samples,
          COUNT(CASE WHEN snr IS NOT NULL OR rssi IS NOT NULL THEN 1 END) as samples_with_signal
        FROM samples
        WHERE observer IN (${placeholders})
        GROUP BY observer
        ORDER BY observer
      `;

      const verifyResult = await client.query(verifyQuery, specifiedObservers);
      const foundObservers = verifyResult.rows.map(row => row.observer);
      const notFound = specifiedObservers.filter(obs => !foundObservers.includes(obs));

      if (notFound.length > 0) {
        console.log(`\nWarning: The following observers were not found in the database:`);
        notFound.forEach(obs => console.log(`  - ${obs}`));
      }

      if (verifyResult.rows.length === 0) {
        console.log('\nNo samples found for the specified observers. Nothing to do.');
        return;
      }

      console.log('\nObserver details:');
      verifyResult.rows.forEach(obs => {
        console.log(`  ${obs.observer}: ${obs.total_samples} samples, ${obs.samples_with_signal} with signal data`);
      });

      observersToRemove = verifyResult.rows.map(row => row.observer);
    } else {
      // Automatic mode: find observers with no signal data
      console.log('\nAutomatic mode: Finding observers with no signal data...');

      const observerAnalysisQuery = `
        SELECT
          observer,
          COUNT(*) as total_samples,
          COUNT(CASE WHEN snr IS NOT NULL OR rssi IS NOT NULL THEN 1 END) as samples_with_signal,
          COUNT(CASE WHEN observed = true AND snr IS NULL AND rssi IS NULL THEN 1 END) as mqtt_like_samples
        FROM samples
        WHERE observer IS NOT NULL
        GROUP BY observer
        ORDER BY total_samples DESC
      `;

      const analysisResult = await client.query(observerAnalysisQuery);
      const observers = analysisResult.rows;

      // Identify MQTT observers: those with no samples that have signal data
      const mqttObservers = observers.filter(obs => parseInt(obs.samples_with_signal) === 0);

      if (mqttObservers.length === 0) {
        console.log('No MQTT observers found (all observers have at least one sample with signal data).');
        console.log('\nObserver summary:');
        observers.forEach(obs => {
          console.log(`  ${obs.observer}: ${obs.total_samples} samples, ${obs.samples_with_signal} with signal`);
        });
        return;
      }

      console.log(`\nFound ${mqttObservers.length} MQTT observers (no signal data in any samples):`);
      mqttObservers.forEach(obs => {
        console.log(`  ${obs.observer}: ${obs.total_samples} samples (all without signal data)`);
      });

      observersToRemove = mqttObservers.map(obs => obs.observer);
    }

    const totalSamplesQuery = `
      SELECT COUNT(*) as count
      FROM samples
      WHERE observer IN (${observersToRemove.map((_, i) => `$${i + 1}`).join(', ')})
    `;
    const totalResult = await client.query(totalSamplesQuery, observersToRemove);
    const totalSamples = parseInt(totalResult.rows[0].count);

    console.log(`\nTotal samples to update: ${totalSamples}`);

    if (dryRun) {
      console.log('\n[DRY RUN] Would clear observer field for these samples.');
      console.log('Run with --confirm to actually perform the update.');
      return;
    }

    // Actually perform the update: clear observer for samples from specified observers
    const placeholders = observersToRemove.map((_, i) => `$${i + 1}`).join(', ');

    const updateQuery = `
      UPDATE samples
      SET observer = NULL
      WHERE observer IN (${placeholders})
    `;

    const updateResult = await client.query(updateQuery, observersToRemove);
    console.log(`\nCleared observer field for ${updateResult.rowCount} samples.`);
    console.log('MQTT observers have been removed from the database.');

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--confirm');
  const confirm = args.includes('--confirm');

  // Parse --observers flag and collect observer names
  const observersIndex = args.indexOf('--observers');
  let specifiedObservers = null;

  if (observersIndex !== -1) {
    // Collect all arguments after --observers until next flag
    specifiedObservers = [];
    for (let i = observersIndex + 1; i < args.length; i++) {
      if (args[i].startsWith('--')) {
        break; // Stop at next flag
      }
      specifiedObservers.push(args[i]);
    }

    if (specifiedObservers.length === 0) {
      console.error('Error: --observers flag requires at least one observer name');
      console.log('\nUsage: node scripts/remove-mqtt-observers.js --observers "Observer1" "Observer2" [--dry-run] [--confirm]');
      process.exit(1);
    }
  }

  if (!dryRun && !confirm) {
    console.log('Usage: node scripts/remove-mqtt-observers.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --observers: Specify observer names to remove (space-separated, quoted)');
    console.log('  --dry-run: Show what would be changed (default)');
    console.log('  --confirm: Actually perform the update');
    console.log('');
    console.log('Examples:');
    console.log('  # Automatic detection');
    console.log('  node scripts/remove-mqtt-observers.js --dry-run');
    console.log('  node scripts/remove-mqtt-observers.js --confirm');
    console.log('');
    console.log('  # Remove specific observers');
    console.log('  node scripts/remove-mqtt-observers.js --observers "Observer1" "Observer2" --dry-run');
    console.log('  node scripts/remove-mqtt-observers.js --observers "Observer1" "Observer2" --confirm');
    process.exit(1);
  }

  try {
    await removeMqttObservers(dryRun, specifiedObservers);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { removeMqttObservers };
