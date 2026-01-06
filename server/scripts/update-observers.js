/**
 * Script to update driver names for samples in a specific time range
 *
 * This script allows you to:
 * - Update driver name for all samples from a specific driver in a time range
 * - Update driver name for all samples matching certain criteria
 *
 * Usage:
 *   # Query samples by time range (no driver required)
 *   node scripts/update-observers.js --time-range "7:00-7:20" [--dry-run]
 *
 *   # Update driver for a specific time range
 *   node scripts/update-observers.js --old-name "old-name" --new-name "new-name" --time-range "7:00-7:20" [--dry-run] [--confirm]
 *
 *   # Update driver for all samples from a specific driver
 *   node scripts/update-observers.js --old-name "old-name" --new-name "new-name" [--dry-run] [--confirm]
 *
 * Options:
 *   --old-name: Current driver name to update (optional, required only when updating)
 *   --new-name: New driver name (optional, required only when updating)
 *   --start-time: Start timestamp in milliseconds (optional, for time range filtering)
 *   --end-time: End timestamp in milliseconds (optional, for time range filtering)
 *   --time-range: Time range in format "HH:MM-HH:MM" (e.g., "7:00-7:20") in PST/PDT - matches any date (converted to UTC)
 *   --date: Date in format "YYYY-MM-DD" (optional, used with --time-range)
 *   --dry-run: Show what would be changed without making changes (default)
 *   --confirm: Actually perform the update
 *
 * Examples:
 *   # Filter by time of day (7:00 AM to 7:20 AM) across all dates
 *   node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --time-range "7:00-7:20" --dry-run
 *
 *   # Filter by time on a specific date
 *   node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --time-range "7:00-7:20" --date "2024-01-01" --dry-run
 *
 *   # Using timestamps (old method)
 *   node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --start-time 1704067200000 --end-time 1704153600000 --dry-run
 *
 *   # Update all samples from a driver (no time range)
 *   node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --confirm
 *
 *   # Docker container
 *   docker-compose exec app node scripts/update-observers.js --old-name "old" --new-name "new" --start-time 1704067200000 --end-time 1704153600000 --dry-run
 */

require('dotenv').config();
const pool = require('../src/config/database');

/**
 * Get the DST offset for America/Los_Angeles on a given date
 * @param {Date} date - Date to check
 * @returns {number} - Offset in minutes (PST = -480, PDT = -420)
 */
function getPSTPDTOffset(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate();

  // DST in US: 2nd Sunday in March to 1st Sunday in November
  // PST = UTC-8 = -480 minutes
  // PDT = UTC-7 = -420 minutes

  // Helper to find nth occurrence of a day of week in a month
  const findNthDay = (year, month, dayOfWeek, n) => {
    const firstDay = new Date(year, month - 1, 1).getDay();
    const offset = (dayOfWeek - firstDay + 7) % 7;
    return 1 + offset + (n - 1) * 7;
  };

  const secondSundayMarch = findNthDay(year, 3, 0, 2); // 0 = Sunday
  const firstSundayNovember = findNthDay(year, 11, 0, 1);

  // Check if date is in DST period
  let isDST = false;
  if (month > 3 && month < 11) {
    isDST = true; // Definitely in DST period
  } else if (month === 3) {
    // March: DST starts on 2nd Sunday
    isDST = day >= secondSundayMarch;
  } else if (month === 11) {
    // November: DST ends on 1st Sunday (not inclusive)
    isDST = day < firstSundayNovember;
  }
  // January, February, December: definitely PST

  return isDST ? -420 : -480; // PDT: -7 hours, PST: -8 hours
}

/**
 * Convert PST/PDT time to UTC time
 * @param {number} hour - Hour in PST/PDT (0-23)
 * @param {number} minute - Minute (0-59)
 * @param {Date} referenceDate - Reference date to determine DST (defaults to today)
 * @returns {Object} - { hour: UTC hour, minute: UTC minute, minutesSinceMidnight: UTC minutes since midnight }
 */
function convertPSTToUTC(hour, minute, referenceDate = new Date()) {
  const offsetMinutes = getPSTPDTOffset(referenceDate);

  // Convert PST/PDT time to UTC
  // PST/PDT time + offset = UTC time
  // But offset is negative, so we subtract it (add the absolute value)
  const pstMinutes = hour * 60 + minute;
  const utcMinutes = pstMinutes - offsetMinutes; // offsetMinutes is negative, so this adds

  // Handle day rollover
  let utcMinutesSinceMidnight = utcMinutes;
  if (utcMinutesSinceMidnight < 0) {
    utcMinutesSinceMidnight += 24 * 60; // Previous day
  } else if (utcMinutesSinceMidnight >= 24 * 60) {
    utcMinutesSinceMidnight -= 24 * 60; // Next day
  }

  const utcHour = Math.floor(utcMinutesSinceMidnight / 60) % 24;
  const utcMin = utcMinutesSinceMidnight % 60;

  return {
    hour: utcHour,
    minute: utcMin,
    minutesSinceMidnight: utcMinutesSinceMidnight
  };
}

function parseTimeRange(timeRangeStr, dateStr = null) {
  // Parse time range like "7:00-7:20" or "07:00-07:20"
  // Input is interpreted as PST/PDT (America/Los_Angeles)
  const match = timeRangeStr.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error('Invalid time range format. Use "HH:MM-HH:MM" (e.g., "7:00-7:20")');
  }

  const startHour = parseInt(match[1]);
  const startMin = parseInt(match[2]);
  const endHour = parseInt(match[3]);
  const endMin = parseInt(match[4]);

  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    throw new Error('Hours must be between 0 and 23');
  }
  if (startMin < 0 || startMin > 59 || endMin < 0 || endMin > 59) {
    throw new Error('Minutes must be between 0 and 59');
  }

  let startTime, endTime;
  let startMinutes, endMinutes; // UTC minutes since midnight

  if (dateStr) {
    // Specific date provided - convert PST/PDT to UTC timestamp
    const [year, month, day] = dateStr.split('-').map(Number);
    const referenceDate = new Date(year, month - 1, day);

    // Convert PST/PDT times to UTC
    const startUTC = convertPSTToUTC(startHour, startMin, referenceDate);
    const endUTC = convertPSTToUTC(endHour, endMin, referenceDate);

    // Create UTC timestamps
    const startDate = new Date(Date.UTC(year, month - 1, day, startUTC.hour, startUTC.minute, 0, 0));
    const endDate = new Date(Date.UTC(year, month - 1, day, endUTC.hour, endUTC.minute, 0, 0));

    // Handle day rollover
    if (startUTC.minutesSinceMidnight >= 24 * 60) {
      startDate.setUTCDate(startDate.getUTCDate() + 1);
    } else if (startUTC.minutesSinceMidnight < 0) {
      startDate.setUTCDate(startDate.getUTCDate() - 1);
    }
    if (endUTC.minutesSinceMidnight >= 24 * 60) {
      endDate.setUTCDate(endDate.getUTCDate() + 1);
    } else if (endUTC.minutesSinceMidnight < 0) {
      endDate.setUTCDate(endDate.getUTCDate() - 1);
    }

    startTime = startDate.getTime();
    endTime = endDate.getTime();
    startMinutes = startUTC.minutesSinceMidnight;
    endMinutes = endUTC.minutesSinceMidnight;
  } else {
    // Time-only filtering: convert PST/PDT to UTC minutes since midnight
    // Use today's date to determine DST
    const today = new Date();
    const startUTC = convertPSTToUTC(startHour, startMin, today);
    const endUTC = convertPSTToUTC(endHour, endMin, today);

    startMinutes = startUTC.minutesSinceMidnight;
    endMinutes = endUTC.minutesSinceMidnight;

    // For display purposes, create UTC timestamps using today
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    const day = today.getUTCDate();
    const startDate = new Date(Date.UTC(year, month, day, startUTC.hour, startUTC.minute, 0, 0));
    const endDate = new Date(Date.UTC(year, month, day, endUTC.hour, endUTC.minute, 0, 0));
    startTime = startDate.getTime();
    endTime = endDate.getTime();
  }

  return {
    startTime: startTime,
    endTime: endTime,
    startMinutes: startMinutes,
    endMinutes: endMinutes,
    isTimeOnly: !dateStr // If no date, we'll filter by time of day across all dates
  };
}

async function updateObservers(dryRun = true, oldName, newName, startTime = null, endTime = null, timeOnly = false, timeRangeData = null) {
  const client = await pool.connect();

  try {
    // First, check if drivers column exists
    const columnCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'samples' AND column_name = 'drivers'
    `);

    if (columnCheck.rows.length === 0) {
      console.log('Drivers column does not exist. Nothing to do.');
      return;
    }

    // Driver name is only required if we're updating
    // Note: oldName can be empty string '' to update null drivers
    if ((oldName === null || oldName === undefined) && (newName === null || newName === undefined)) {
      // Just querying - no driver required
    } else if ((oldName === null || oldName === undefined) || (newName === null || newName === undefined)) {
      console.error('Error: Both --old-name and --new-name are required when updating drivers');
      console.error('Use --old-name "" to update null drivers');
      process.exit(1);
    } else if (oldName === newName && oldName !== '') {
      console.error('Error: Old name and new name cannot be the same');
      process.exit(1);
    }

    // Build query with optional time range and optional driver
    let query = `
      SELECT
        COUNT(*) as total_samples,
        COUNT(CASE WHEN snr IS NOT NULL OR rssi IS NOT NULL THEN 1 END) as samples_with_signal,
        MIN(time) as earliest_time,
        MAX(time) as latest_time,
        COUNT(DISTINCT drivers) as unique_drivers
      FROM samples
      WHERE 1=1
    `;
    const params = [];

    if (oldName !== null && oldName !== undefined) {
      if (oldName === '') {
        // Query for null drivers
        query += ` AND drivers IS NULL`;
      } else {
        query += ` AND drivers = $${params.length + 1}`;
        params.push(oldName);
      }
    }

    // Build drivers list query (same filters) - only if not filtering by specific driver
    let driversQuery = null;
    const driversParams = [];

    if (oldName === null || oldName === undefined) {
      driversQuery = `
        SELECT
          COALESCE(drivers, '(null)') as drivers,
          COUNT(*) as sample_count,
          COUNT(CASE WHEN snr IS NOT NULL OR rssi IS NOT NULL THEN 1 END) as samples_with_signal
        FROM samples
        WHERE 1=1
      `;
    }

    // Helper function to add time filters to a query
    const addTimeFilters = (q, p) => {
      if (timeOnly && timeRangeData) {
        const startMinutes = timeRangeData.startMinutes;
        const endMinutes = timeRangeData.endMinutes;
        // Extract hour/minute from UTC timestamp
        // time is stored as milliseconds since epoch (UTC)
        // to_timestamp(time / 1000) gives UTC timestamp
        q += ` AND (
          EXTRACT(HOUR FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') * 60 +
          EXTRACT(MINUTE FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') >= $${p.length + 1}
          AND
          EXTRACT(HOUR FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') * 60 +
          EXTRACT(MINUTE FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') <= $${p.length + 2}
        )`;
        p.push(startMinutes);
        p.push(endMinutes);
      } else {
        if (startTime !== null) {
          q += ` AND time >= $${p.length + 1}`;
          p.push(startTime);
        }
        if (endTime !== null) {
          q += ` AND time <= $${p.length + 1}`;
          p.push(endTime);
        }
      }
      return q;
    };

    query = addTimeFilters(query, params);

    if (driversQuery) {
      driversQuery = addTimeFilters(driversQuery, driversParams);
      driversQuery += ` GROUP BY drivers ORDER BY COUNT(*) DESC`;
    }

    const verifyResult = await client.query(query, params);

    if (verifyResult.rows.length === 0 || parseInt(verifyResult.rows[0].total_samples) === 0) {
      if (oldName !== null && oldName !== undefined) {
        if (oldName === '') {
          console.log(`\nNo samples found with null drivers`);
        } else {
          console.log(`\nNo samples found for driver "${oldName}"`);
        }
      } else {
        console.log(`\nNo samples found`);
      }
      if (startTime !== null || endTime !== null || timeOnly) {
        console.log(`  Time range: ${startTime ? new Date(startTime).toISOString() : 'any'} to ${endTime ? new Date(endTime).toISOString() : 'any'}`);
      }
      return;
    }

    const stats = verifyResult.rows[0];
    const totalSamples = parseInt(stats.total_samples);
    const samplesWithSignal = parseInt(stats.samples_with_signal);
    const uniqueDrivers = parseInt(stats.unique_drivers) || 0;
    const earliestTime = stats.earliest_time ? new Date(parseInt(stats.earliest_time)).toISOString() : 'N/A';
    const latestTime = stats.latest_time ? new Date(parseInt(stats.latest_time)).toISOString() : 'N/A';

    if (oldName !== null && oldName !== undefined) {
      if (oldName === '') {
        console.log(`\nFound ${totalSamples} sample(s) with null drivers`);
      } else {
        console.log(`\nFound ${totalSamples} sample(s) for driver "${oldName}"`);
      }
    } else {
      console.log(`\nFound ${totalSamples} sample(s)`);
      if (uniqueDrivers > 0) {
        console.log(`  Unique drivers: ${uniqueDrivers}`);
      }
    }
    console.log(`  Samples with signal data: ${samplesWithSignal}`);
    console.log(`  Time range: ${earliestTime} to ${latestTime}`);
    if (startTime !== null || endTime !== null || timeOnly) {
      console.log(`  Filter time range: ${startTime ? new Date(startTime).toISOString() : 'any'} to ${endTime ? new Date(endTime).toISOString() : 'any'}`);
    }

    // Show observer breakdown if not filtering by specific observer
    if (observerQuery) {
      try {
        const observerResult = await client.query(observerQuery, observerParams);
        if (observerResult.rows.length > 0) {
          console.log(`\nObservers in this time range (all samples, regardless of signal):`);
          observerResult.rows.forEach(row => {
            const obsName = row.observer === '(null)' ? '(null)' : row.observer;
            const count = parseInt(row.sample_count);
            const withSignal = parseInt(row.samples_with_signal);
            console.log(`  ${obsName}: ${count} sample(s)${withSignal > 0 ? ` (${withSignal} with signal)` : ''}`);
          });
        } else {
          console.log(`\nNo samples found in this time range`);
        }
      } catch (error) {
        console.warn('  (Could not fetch observer breakdown):', error.message);
      }
    }

    // Check if we have both oldName and newName (oldName can be empty string for null drivers)
    const hasOldName = oldName !== null && oldName !== undefined;
    const hasNewName = newName !== null && newName !== undefined;

    if (hasOldName && hasNewName) {
      if (oldName === '') {
        console.log(`\nWill update null observers to "${newName}"`);
      } else {
        console.log(`\nWill update observer from "${oldName}" to "${newName}"`);
      }
    } else {
      console.log(`\n[QUERY ONLY] No driver update specified. Use --old-name and --new-name to update.`);
    }

    if (!hasOldName || !hasNewName) {
      console.log('\n[QUERY ONLY] No update will be performed. Specify --old-name and --new-name to update observers.');
      return;
    }

    if (dryRun) {
      console.log('\n[DRY RUN] Would update driver for these samples.');
      console.log('Run with --confirm to actually perform the update.');
      return;
    }

    // Actually perform the update
    // Allow updating null drivers by checking for empty string or null
    let updateQuery;
    const updateParams = [newName];

    if (oldName === '' || oldName === null || oldName === undefined) {
      // Update all null drivers
      updateQuery = `
        UPDATE samples
        SET drivers = $1
        WHERE drivers IS NULL
      `;
    } else {
      // Update specific driver
      updateQuery = `
        UPDATE samples
        SET drivers = $1
        WHERE drivers = $2
      `;
      updateParams.push(oldName);
    }

    if (timeOnly && timeRangeData) {
      // Filter by time of day only (across all dates)
      const startMinutes = timeRangeData.startMinutes;
      const endMinutes = timeRangeData.endMinutes;

      updateQuery += ` AND (
        EXTRACT(HOUR FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') * 60 + EXTRACT(MINUTE FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') >= $${updateParams.length + 1}
        AND EXTRACT(HOUR FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') * 60 + EXTRACT(MINUTE FROM to_timestamp(time / 1000) AT TIME ZONE 'UTC') <= $${updateParams.length + 2}
      )`;
      updateParams.push(startMinutes);
      updateParams.push(endMinutes);
    } else {
      if (startTime !== null) {
        updateQuery += ` AND time >= $${updateParams.length + 1}`;
        updateParams.push(startTime);
      }

      if (endTime !== null) {
        updateQuery += ` AND time <= $${updateParams.length + 1}`;
        updateParams.push(endTime);
      }
    }

    // Debug output to help diagnose issues
    console.log('\n[DEBUG] Update query:', updateQuery.replace(/\s+/g, ' ').trim());
    console.log('[DEBUG] Update params:', updateParams.map((p, i) => `$${i + 1} = ${typeof p === 'string' ? `"${p}"` : p}`).join(', '));
    console.log('[DEBUG] startTime:', startTime, startTime ? new Date(startTime).toISOString() : 'null');
    console.log('[DEBUG] endTime:', endTime, endTime ? new Date(endTime).toISOString() : 'null');
    console.log('[DEBUG] timeOnly:', timeOnly);
    console.log('[DEBUG] oldName type:', typeof oldName, 'value:', oldName === '' ? '(empty string)' : oldName);

    const updateResult = await client.query(updateQuery, updateParams);
    console.log(`\nUpdated driver for ${updateResult.rowCount} sample(s).`);
    if (oldName === '' || oldName === null || oldName === undefined) {
      console.log(`Null drivers have been changed to "${newName}"`);
    } else {
      console.log(`Driver "${oldName}" has been changed to "${newName}"`);
    }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = true;
  let oldName = null;
  let newName = null;
  let startTime = null;
  let endTime = null;
  let timeOnly = false;
  let timeRangeStr = null;
  let dateStr = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--confirm':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--old-name':
        oldName = args[++i];
        break;
      case '--new-name':
        newName = args[++i];
        break;
      case '--start-time':
        startTime = parseInt(args[++i]);
        if (isNaN(startTime)) {
          console.error('Error: --start-time must be a valid number (milliseconds)');
          pool.end().finally(() => process.exit(1));
          return;
        }
        break;
      case '--end-time':
        endTime = parseInt(args[++i]);
        if (isNaN(endTime)) {
          console.error('Error: --end-time must be a valid number (milliseconds)');
          pool.end().finally(() => process.exit(1));
          return;
        }
        break;
      case '--time-range':
        timeRangeStr = args[++i];
        break;
      case '--date':
        dateStr = args[++i];
        break;
      case '--help':
        console.log(`
Usage: node scripts/update-observers.js [options]

Options:
  --old-name <name>     Current driver name to update (optional, required only when updating)
                         Use "" (empty string) to update null drivers
  --new-name <name>     New driver name (optional, required only when updating)
  --time-range <range>  Time range in format "HH:MM-HH:MM" (e.g., "7:00-7:20") in PST/PDT (converted to UTC)
  --date <date>         Date in format "YYYY-MM-DD" (optional, can be used alone or with --time-range/--start-time/--end-time)
  --start-time <ms>     Start timestamp in milliseconds (optional)
  --end-time <ms>       End timestamp in milliseconds (optional)
  --dry-run            Show what would change (default)
  --confirm            Actually perform the update
  --help               Show this help message

Examples:
  # Query samples by time range (no driver required)
  node scripts/update-observers.js --time-range "7:00-7:20"

  # Query samples by time range on a specific date
  node scripts/update-observers.js --time-range "7:00-7:20" --date "2024-01-01"

  # Update driver for samples in time range
  node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --time-range "7:00-7:20" --dry-run

  # Update driver for samples on a specific date and time
  node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --time-range "7:00-7:20" --date "2024-01-01" --confirm

  # Using timestamps (old method)
  node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --start-time 1704067200000 --end-time 1704153600000 --confirm

  # Update all samples from a driver
  node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --confirm

  # Update all null drivers in a time range
  node scripts/update-observers.js --old-name "" --new-name "device-1" --time-range "7:00-7:20" --confirm

  # Query all samples on a specific date (entire day)
  node scripts/update-observers.js --date "2024-01-01"

  # Update driver for all samples on a specific date
  node scripts/update-observers.js --old-name "device-1" --new-name "device-2" --date "2024-01-01" --confirm
        `);
        process.exit(0);
        break;
    }
  }

  // Driver names are only required if updating, not for querying
  // Allow updating null drivers by passing empty string
  // Note: oldName can be '' (empty string) to update null drivers
  const hasOldName = oldName !== null && oldName !== undefined;
  const hasNewName = newName !== null && newName !== undefined;

  if ((hasOldName && !hasNewName) || (!hasOldName && hasNewName)) {
    console.error('Error: Both --old-name and --new-name are required when updating drivers');
    console.error('Use --old-name "" to update null drivers, or specify a driver name');
    console.error('Use --help for usage information');
    await pool.end();
    return;
  }

  // If no time range and no driver names, nothing to do
  if (!hasOldName && !hasNewName && !timeRangeStr && startTime === null && endTime === null) {
    console.error('Error: Must specify either driver names (--old-name/--new-name) or time range (--time-range or --start-time/--end-time)');
    console.error('Use --help for usage information');
    await pool.end();
    return;
  }

  // Handle time-range option first (it may use dateStr)
  let timeRangeData = null;
  if (timeRangeStr) {
    try {
      const timeRange = parseTimeRange(timeRangeStr, dateStr);
      startTime = timeRange.startTime;
      endTime = timeRange.endTime;
      timeOnly = timeRange.isTimeOnly;
      timeRangeData = timeRange; // Store the full time range data

      if (timeOnly) {
        console.log(`\nFiltering by time of day: ${timeRangeStr} (across all dates)`);
      } else {
        console.log(`\nFiltering by time: ${timeRangeStr} on ${dateStr || 'specified date'}`);
      }
    } catch (error) {
      console.error('Error parsing time range:', error.message);
      await pool.end();
      return;
    }
  }

  // Handle date option - can be used independently or with time filters
  if (dateStr && !timeRangeStr && startTime === null && endTime === null) {
    // Date only - filter by entire day
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      if (isNaN(year) || isNaN(month) || isNaN(day)) {
        throw new Error('Invalid date format. Use YYYY-MM-DD');
      }

      // Create start and end times for the entire day in UTC
      // Start of day: 00:00:00 UTC
      // End of day: 23:59:59.999 UTC
      const startDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      const endDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
      startTime = startDate.getTime();
      endTime = endDate.getTime();
      timeOnly = false;
      console.log(`\nFiltering by date: ${dateStr} (entire day)`);
    } catch (error) {
      console.error('Error parsing date:', error.message);
      await pool.end();
      return;
    }
  } else if (dateStr && timeRangeStr) {
    // Date is already handled by parseTimeRange when timeRangeStr is provided
    // Just log confirmation
    if (!timeOnly) {
      console.log(`  Date: ${dateStr}`);
    }
  } else if (dateStr && (startTime !== null || endTime !== null)) {
    // Date with start-time or end-time - adjust times to be on that date
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      if (isNaN(year) || isNaN(month) || isNaN(day)) {
        throw new Error('Invalid date format. Use YYYY-MM-DD');
      }

      if (startTime !== null) {
        const startDate = new Date(startTime);
        startDate.setUTCFullYear(year, month - 1, day);
        startTime = startDate.getTime();
      }

      if (endTime !== null) {
        const endDate = new Date(endTime);
        endDate.setUTCFullYear(year, month - 1, day);
        endTime = endDate.getTime();
      }

      console.log(`\nFiltering by date: ${dateStr} with specified times`);
    } catch (error) {
      console.error('Error parsing date:', error.message);
      await pool.end();
      return;
    }
  }

  if (startTime !== null && endTime !== null && !timeOnly && startTime > endTime) {
    console.error('Error: --start-time must be less than or equal to --end-time');
    await pool.end();
    return;
  }

  try {
    await updateObservers(dryRun, oldName, newName, startTime, endTime, timeOnly, timeRangeData);
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Failed to update drivers:', error);
    await pool.end();
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    pool.end().then(() => process.exit(1)).catch(() => process.exit(1));
  });
}

module.exports = { updateObservers };
