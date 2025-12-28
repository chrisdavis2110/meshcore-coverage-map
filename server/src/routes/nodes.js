const express = require('express');
const router = express.Router();
const coverageModel = require('../models/coverage');
const samplesModel = require('../models/samples');
const repeatersModel = require('../models/repeaters');
const { truncateTime } = require('../utils/shared');
const { buildPrefixLookup, disambiguatePath } = require('../utils/prefix-disambiguation');

// GET /get-nodes
router.get('/get-nodes', async (req, res, next) => {
  try {
    const [coverage, samples, repeaters] = await Promise.all([
      coverageModel.getAll(),
      samplesModel.getAll(),
      repeatersModel.getAll()
    ]);

    // Build prefix disambiguation lookup from samples and repeaters
    // This resolves 2-char prefix collisions using position, co-occurrence, geography, and recency
    const prefixLookup = buildPrefixLookup(samples.keys, repeaters.keys);

    // Aggregate samples by 6-character geohash prefix
    const sampleAggregates = new Map(); // geohash prefix -> { total, heard, lastTime, repeaters: Set, snr, rssi }

    samples.keys.forEach(s => {
      const prefix = s.name.substring(0, 6); // 6-char geohash prefix
      const rawPath = s.metadata.path || [];
      // Disambiguate path prefixes to resolve collisions
      const path = disambiguatePath(prefixLookup, rawPath);
      const heard = path.length > 0;
      const observed = s.metadata.observed ?? heard;
      const time = s.metadata.time || 0;
      const snr = s.metadata.snr ?? null;
      const rssi = s.metadata.rssi ?? null;

      if (!sampleAggregates.has(prefix)) {
        sampleAggregates.set(prefix, {
          total: 0,
          observed: 0,
          heard: 0,
          lastTime: 0,
          repeaters: new Set(),
          snr: null,
          rssi: null
        });
      }

      const agg = sampleAggregates.get(prefix);
      agg.total++;
      if (observed) agg.observed++;
      if (heard) agg.heard++;
      if (time > agg.lastTime) agg.lastTime = time;

      // Track max snr/rssi (similar to database upsert logic)
      if (snr !== null) {
        agg.snr = (agg.snr === null) ? snr : Math.max(agg.snr, snr);
      }
      if (rssi !== null) {
        agg.rssi = (agg.rssi === null) ? rssi : Math.max(agg.rssi, rssi);
      }

      // Track which repeaters were hit
      path.forEach(repeaterId => {
        agg.repeaters.add(repeaterId);
      });
    });

    // Convert aggregates to array format
    const aggregatedSamples = Array.from(sampleAggregates.entries()).map(([id, agg]) => {
      const path = Array.from(agg.repeaters);
      const lost = agg.total - agg.heard;
      const item = {
        id: id,
        time: truncateTime(agg.lastTime),
        obs: agg.observed > 0 ? 1 : 0,
        heard: agg.heard,
        lost: lost,
      };

      // Include path if any repeaters were hit
      if (path.length > 0) {
        item.path = path.sort();
      }

      // Include snr/rssi if they exist
      if (agg.snr !== null) {
        item.snr = agg.snr;
      }
      if (agg.rssi !== null) {
        item.rssi = agg.rssi;
      }

      return item;
    });

    const responseData = {
      coverage: coverage.map(c => {
        const lastHeard = c.lastHeard || 0;
        const lastObserved = c.lastObserved || lastHeard;
        const updated = lastObserved || lastHeard;
        const item = {
          id: c.hash,
          obs: c.observed ?? c.heard ?? 0,
          rcv: c.heard || 0,
          lost: c.lost || 0,
          ut: truncateTime(updated),
          lht: truncateTime(lastHeard),
          lot: truncateTime(lastObserved),
        };

        if (c.hitRepeaters && c.hitRepeaters.length > 0) {
          // Disambiguate repeater prefixes in coverage data
          item.rptr = disambiguatePath(prefixLookup, c.hitRepeaters);
        }

        // Include snr/rssi if they exist
        if (c.snr !== null && c.snr !== undefined) {
          item.snr = c.snr;
        }
        if (c.rssi !== null && c.rssi !== undefined) {
          item.rssi = c.rssi;
        }

        return item;
      }),
      samples: aggregatedSamples,
      repeaters: repeaters.keys.map(r => ({
        time: truncateTime(r.metadata.time),
        id: r.metadata.id,
        name: r.metadata.name,
        lat: r.metadata.lat,
        lon: r.metadata.lon,
        elev: Math.round(r.metadata.elev || 0),
      }))
    };

    res.json(responseData);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
