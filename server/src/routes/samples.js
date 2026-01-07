const express = require('express');
const router = express.Router();
const samplesModel = require('../models/samples');
const driversModel = require('../models/drivers');
const repeatersModel = require('../models/repeaters');
const { parseLocation, sampleKey, coverageKey, definedOr, or, ageInDays } = require('../utils/shared');

// GET /get-samples?p=<prefix>
router.get('/get-samples', async (req, res, next) => {
  try {
    const prefix = req.query.p || null;
    const samples = await samplesModel.getByPrefix(prefix);

    // Format response to match expected structure (name + metadata)
    // Also include flat format for backward compatibility
    const formatted = {
      keys: samples.keys.map(s => {
        const path = s.metadata.path ?? [];
        return {
          name: s.name, // geohash
          metadata: {
            time: s.metadata.time,
            path: path,
            rssi: s.metadata.rssi ?? null,
            snr: s.metadata.snr ?? null,
            observed: s.metadata.observed ?? path.length > 0,
            drivers: s.metadata.drivers ?? null
          },
          // Also include flat format for compatibility
          hash: s.name,
          time: s.metadata.time,
          path: path,
          rssi: s.metadata.rssi ?? null,
          snr: s.metadata.snr ?? null,
          observed: s.metadata.observed ?? path.length > 0,
          drivers: s.metadata.drivers ?? null
        };
      })
    };

    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// POST /put-sample
router.post('/put-sample', express.json(), async (req, res, next) => {
  try {
    const { lat, lon, path, snr, rssi, observed, repeaterPubkey, drivers } = req.body;
    const [parsedLat, parsedLon] = parseLocation(lat, lon);
    const time = Date.now();
    const normalizedPath = (path ?? []).map(p => p.toLowerCase());
    const geohash = sampleKey(parsedLat, parsedLon);

    // Get existing sample to merge metadata
    const existing = await samplesModel.getWithMetadata(geohash);

    let metadata = {
      time: time,
      path: normalizedPath,
      snr: snr ?? null,
      rssi: rssi ?? null,
      observed: observed ?? normalizedPath.length > 0,
      drivers: drivers ?? null
    };

    if (metadata.drivers != null && metadata.drivers !== '') {
      // Wardrive request - always use the drivers (for both hits and misses)
      // This ensures driver stats track all pings from the user
    } else {
      // MQTT request - preserve existing drivers, never update it
      if (existing.value !== null && existing.metadata !== null) {
        metadata.drivers = existing.metadata.drivers ?? null;
      } else {
        metadata.drivers = null; // No existing drivers, MQTT doesn't set one
      }
    }

    // Merge other fields if recent (< 1 day old)
    if (existing.value !== null && existing.metadata !== null && ageInDays(existing.metadata.time) < 1) {
      metadata = {
        time: Math.max(metadata.time, existing.metadata.time),
        snr: definedOr(Math.max, metadata.snr, existing.metadata.snr),
        rssi: definedOr(Math.max, metadata.rssi, existing.metadata.rssi),
        observed: definedOr(or, metadata.observed, existing.metadata.observed),
        path: Array.from(new Set([...metadata.path, ...(existing.metadata.path || [])])),
        drivers: metadata.drivers // Already set above based on request source
      };
    }

    // Upsert - the database will handle merging paths atomically
    await samplesModel.upsert(geohash, metadata.time, metadata.path, metadata.observed, metadata.snr, metadata.rssi, metadata.drivers);

    // If ping is observed and we have a driver name, convert miss to hit
    // (decrement miss, increment hit) only if there's a recent miss for this driver+geohash+time
    // Skip if drivers is null or empty (handles cases where drivers column may not exist)
    const isObserved = metadata.observed || normalizedPath.length > 0;
    if (isObserved && metadata.drivers && metadata.drivers !== '' && metadata.drivers !== null) {
      try {
        const coverageGeohash = coverageKey(parsedLat, parsedLon);
        // Check driver, geohash, and time (within 5 minute window) before converting
        const converted = await driversModel.convertMissToHitIfRecent(
          metadata.drivers,
          coverageGeohash,
          metadata.time,
          300000 // 5 minute time window
        );
        if (!converted) {
          // No recent miss found, just increment hit without decrementing miss
          await driversModel.incrementHit(metadata.drivers, coverageGeohash);
        }
      } catch (e) {
        // Log but don't fail the request if driver update fails
        // This handles cases where drivers table or column might not exist
        console.warn(`Failed to update driver hit for ${metadata.drivers}:`, e);
      }
    }

    // If we have a repeater public key, update/create the repeater entry
    if (repeaterPubkey && normalizedPath.length > 0) {
      const repeaterId = normalizedPath[0]; // First repeater in path (2-char hex)
      try {
        // Update repeater with full public key at this location
        await repeatersModel.upsert(repeaterId, parsedLat, parsedLon, null, null, time, repeaterPubkey);
      } catch (e) {
        // Log but don't fail the request if repeater update fails
        console.warn(`Failed to update repeater ${repeaterId} with pubkey:`, e);
      }
    }

    res.send('OK');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
