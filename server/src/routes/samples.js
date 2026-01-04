const express = require('express');
const router = express.Router();
const samplesModel = require('../models/samples');
const repeatersModel = require('../models/repeaters');
const { parseLocation, sampleKey, definedOr, or, ageInDays } = require('../utils/shared');

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
            observer: s.metadata.observer ?? null
          },
          // Also include flat format for compatibility
          hash: s.name,
          time: s.metadata.time,
          path: path,
          rssi: s.metadata.rssi ?? null,
          snr: s.metadata.snr ?? null,
          observed: s.metadata.observed ?? path.length > 0,
          observer: s.metadata.observer ?? null
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
    const { lat, lon, path, snr, rssi, observed, repeaterPubkey, observer } = req.body;
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
      observer: observer ?? null
    };

    // Merge with existing if recent (< 1 day old)
    if (existing.value !== null && existing.metadata !== null && ageInDays(existing.metadata.time) < 1) {
      metadata = {
        time: Math.max(metadata.time, existing.metadata.time),
        snr: definedOr(Math.max, metadata.snr, existing.metadata.snr),
        rssi: definedOr(Math.max, metadata.rssi, existing.metadata.rssi),
        observed: definedOr(or, metadata.observed, existing.metadata.observed),
        path: Array.from(new Set([...metadata.path, ...(existing.metadata.path || [])])),
        observer: metadata.observer || existing.metadata.observer || null
      };
    }

    // Upsert - the database will handle merging paths atomically
    await samplesModel.upsert(geohash, metadata.time, metadata.path, metadata.observed, metadata.snr, metadata.rssi, metadata.observer);

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
