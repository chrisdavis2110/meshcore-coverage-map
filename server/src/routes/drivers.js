const express = require('express');
const router = express.Router();
const driversModel = require('../models/drivers');
const { coverageKey, parseLocation } = require('../utils/shared');

// POST /update-driver-miss - Called when a ping is sent
router.post('/update-driver-miss', express.json(), async (req, res, next) => {
  try {
    const { name, lat, lon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    const [parsedLat, parsedLon] = parseLocation(lat, lon);
    const geohash = coverageKey(parsedLat, parsedLon);

    await driversModel.incrementMiss(name, geohash);

    res.send('OK');
  } catch (error) {
    next(error);
  }
});

// POST /update-driver-hit - Called when a ping is observed
router.post('/update-driver-hit', express.json(), async (req, res, next) => {
  try {
    const { name, lat, lon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    const [parsedLat, parsedLon] = parseLocation(lat, lon);
    const geohash = coverageKey(parsedLat, parsedLon);

    await driversModel.convertMissToHit(name, geohash);

    res.send('OK');
  } catch (error) {
    next(error);
  }
});

// GET /get-driver-stats?name=<driver_name>
router.get('/get-driver-stats', async (req, res, next) => {
  try {
    const name = req.query.name;
    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    const stats = await driversModel.getStats(name);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// GET /get-driver-coverage?name=<driver_name>
router.get('/get-driver-coverage', async (req, res, next) => {
  try {
    const name = req.query.name;
    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    const coverage = await driversModel.getByDriver(name);
    res.json(coverage);
  } catch (error) {
    next(error);
  }
});

// GET /get-drivers - Returns all drivers in migration format
router.get('/get-drivers', async (req, res, next) => {
  try {
    const drivers = await driversModel.getAll();

    // Format response to match migration format { keys: [...] }
    const formatted = {
      keys: drivers.map(row => ({
        name: `${row.name}|${row.geohash}`,
        metadata: {
          name: row.name,
          geohash: row.geohash,
          hit: row.hit || 0,
          miss: row.miss || 0,
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      }))
    };

    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// POST /put-driver - Accepts driver data for migration
router.post('/put-driver', express.json(), async (req, res, next) => {
  try {
    const { name, geohash, hit, miss } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    if (!geohash) {
      return res.status(400).json({ error: 'Geohash is required' });
    }

    await driversModel.upsert(name, geohash, hit || 0, miss || 0);

    res.send('OK');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
