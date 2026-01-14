const express = require('express');
const router = express.Router();
const repeatersModel = require('../models/repeaters');
const { parseLocation } = require('../utils/shared');

async function getElevation(lat, lon) {
  try {
    const apiUrl = `https://api.opentopodata.org/v1/ned10m?locations=${lat},${lon}`;
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      console.log(`Error getting elevation for [${lat},${lon}]. HTTP ${resp.status} ${resp.statusText}`);
      return null;
    }

    const data = await resp.json();

    // Check API status at top level
    if (data.status !== 'OK') {
      console.log(`Error getting elevation for [${lat},${lon}]. Status: ${data.status || 'undefined'}. Error: ${data.error || 'unknown'}`);
      return null;
    }

    // Check if results exist and have data
    if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
      console.log(`Error getting elevation for [${lat},${lon}]. No results in response:`, data);
      return null;
    }

    // Check if elevation exists in result
    if (data.results[0].elevation === undefined || data.results[0].elevation === null) {
      console.log(`Error getting elevation for [${lat},${lon}]. Elevation not found in result:`, data.results[0]);
      return null;
    }

    return data.results[0].elevation;
  } catch (e) {
    console.log(`Error getting elevation for [${lat},${lon}]. ${e}`);
    return null;
  }
}

// GET /get-repeaters
router.get('/get-repeaters', async (req, res, next) => {
  try {
    const repeaters = await repeatersModel.getAll();
    res.json(repeaters);
  } catch (error) {
    next(error);
  }
});

// POST /put-repeater
router.post('/put-repeater', express.json(), async (req, res, next) => {
  try {
    const { id, name, lat, lon, pubkey } = req.body;
    const [parsedLat, parsedLon] = parseLocation(lat, lon);
    const time = Date.now();
    const normalizedId = id.toLowerCase();

    // Check if repeater exists to get cached elevation
    const existing = await repeatersModel.getByLocation(normalizedId, parsedLat, parsedLon);
    let elev = existing?.elev || null;

    // Fetch elevation if not cached
    if (elev === null) {
      const elevation = await getElevation(parsedLat, parsedLon);
      // Round to 2 decimal places for storage
      elev = elevation !== null ? Math.round(elevation * 100) / 100 : null;
    }

    await repeatersModel.upsert(normalizedId, parsedLat, parsedLon, name, elev, time, pubkey);

    res.send('OK');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
