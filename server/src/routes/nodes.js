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
    // Track driver stats (drivers -> { count, heard, lost })
    // Only include drivers from wardrive app (nodes sending pings), not MQTT
    // Strategy: First pass - identify wardrive app drivers (those with at least one sample with snr/rssi)
    // Second pass - include all samples from identified wardrive app drivers
    const wardriveAppDrivers = new Set(); // drivers known to be from wardrive app
    const driverStats = new Map(); // driver name -> { count, heard, lost }

    // First pass: identify wardrive app drivers
    // Strategy: Since MQTT no longer has drivers field, ANY sample with drivers field is from wardrive app
    // MQTT: don't have drivers field (we removed it from the scraper)
    // Wardrive app: always has drivers field (device name or "wardrive-user")
    // Note: Old MQTT data might still have drivers fields, but those should be cleaned up with the script
    const allDrivers = new Set();
    samples.keys.forEach(s => {
      const drivers = s.metadata.drivers;

      // Track all drivers for debugging
      if (drivers) {
        allDrivers.add(drivers);
      }

      // Any sample with drivers field is from wardrive app
      // (New MQTT samples don't have drivers field anymore)
      if (drivers) {
        wardriveAppDrivers.add(drivers);
      }
    });

    // Debug logging (remove after testing)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEBUG] Found ${allDrivers.size} unique drivers:`, Array.from(allDrivers));
      console.log(`[DEBUG] Identified ${wardriveAppDrivers.size} wardrive app drivers:`, Array.from(wardriveAppDrivers));
    }

    // Second pass: track stats for all samples from wardrive app drivers
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
      const drivers = s.metadata.drivers;

      // Track driver stats - only for wardrive app users (nodes sending pings)
      // Include if drivers is known to be from wardrive app
      // All wardrive app samples have drivers field, MQTT samples don't (after our changes)
      const isWardriveApp = drivers && wardriveAppDrivers.has(drivers);

      if (isWardriveApp) {
        if (!driverStats.has(drivers)) {
          driverStats.set(drivers, { count: 0, heard: 0, lost: 0 });
        }
        const stats = driverStats.get(drivers);
        stats.count++;
        if (heard) {
          stats.heard++;
        } else {
          stats.lost++;
        }
      }

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

      // Track which repeaters were hit (normalize to lowercase)
      path.forEach(repeaterId => {
        agg.repeaters.add(repeaterId.toLowerCase());
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

    // Convert driver stats to array and apply filters
    const minCount = req.query.minCount ? parseInt(req.query.minCount) : null;
    const maxCount = req.query.maxCount ? parseInt(req.query.maxCount) : null;
    const minHeard = req.query.minHeard ? parseInt(req.query.minHeard) : null;
    const maxHeard = req.query.maxHeard ? parseInt(req.query.maxHeard) : null;
    const minLost = req.query.minLost ? parseInt(req.query.minLost) : null;
    const maxLost = req.query.maxLost ? parseInt(req.query.maxLost) : null;
    const minPercent = req.query.minPercent ? parseFloat(req.query.minPercent) : null;
    const maxPercent = req.query.maxPercent ? parseFloat(req.query.maxPercent) : null;
    const sortBy = req.query.sortBy || 'count'; // 'count', 'heard', 'lost', 'percent'
    const sortOrder = req.query.sortOrder || 'desc'; // 'asc' or 'desc'

    let drivers = Array.from(driverStats.entries())
      .map(([name, stats]) => {
        const total = stats.count;
        const heard = stats.heard;
        const lost = stats.lost;
        const heardPercent = total > 0 ? (heard / total) * 100 : 0;
        return {
          name,
          count: total,
          heard,
          lost,
          heardPercent: Math.round(heardPercent * 10) / 10 // Round to 1 decimal place
        };
      })
      .filter(driver => {
        // Apply filters
        if (minCount !== null && driver.count < minCount) return false;
        if (maxCount !== null && driver.count > maxCount) return false;
        if (minHeard !== null && driver.heard < minHeard) return false;
        if (maxHeard !== null && driver.heard > maxHeard) return false;
        if (minLost !== null && driver.lost < minLost) return false;
        if (maxLost !== null && driver.lost > maxLost) return false;
        if (minPercent !== null && driver.heardPercent < minPercent) return false;
        if (maxPercent !== null && driver.heardPercent > maxPercent) return false;
        return true;
      })
      .sort((a, b) => {
        let aVal, bVal;
        switch (sortBy) {
          case 'heard':
            aVal = a.heard;
            bVal = b.heard;
            break;
          case 'lost':
            aVal = a.lost;
            bVal = b.lost;
            break;
          case 'percent':
            aVal = a.heardPercent;
            bVal = b.heardPercent;
            break;
          case 'count':
          default:
            aVal = a.count;
            bVal = b.count;
            break;
        }
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
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
      })),
      drivers: drivers
    };

    res.json(responseData);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
