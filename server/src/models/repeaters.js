const pool = require('../config/database');

async function getAll(region = null) {
  let query, params, result;

  // Try with region column first, fallback if it doesn't exist
  try {
    if (region) {
      query = 'SELECT id, lat, lon, name, elev, time, pubkey, region FROM repeaters WHERE region = $1 OR region IS NULL ORDER BY id, time DESC';
      params = [region];
    } else {
      query = 'SELECT id, lat, lon, name, elev, time, pubkey, region FROM repeaters ORDER BY id, time DESC';
      params = [];
    }
    result = await pool.query(query, params);
  } catch (e) {
    if (e.code === '42703') {
      // Region column doesn't exist yet, use old schema
      query = 'SELECT id, lat, lon, name, elev, time, pubkey FROM repeaters ORDER BY id, time DESC';
      result = await pool.query(query, []);
    } else {
      throw e;
    }
  }

  return {
    keys: result.rows.map(row => ({
      name: `${row.id}|${parseFloat(row.lat)}|${parseFloat(row.lon)}`,
      metadata: {
        time: row.time,
        id: row.id,
        name: row.name,
        lat: parseFloat(row.lat),
        lon: parseFloat(row.lon),
        elev: row.elev,
        pubkey: row.pubkey,
        region: row.region || null
      }
    }))
  };
}

async function getById(id, region = null) {
  let query, params;
  if (region) {
    query = 'SELECT id, lat, lon, name, elev, time, pubkey, region FROM repeaters WHERE id = $1 AND (region = $2 OR region IS NULL) ORDER BY time DESC';
    params = [id, region];
  } else {
    query = 'SELECT id, lat, lon, name, elev, time, pubkey, region FROM repeaters WHERE id = $1 ORDER BY time DESC';
    params = [id];
  }
  const result = await pool.query(query, params);
  return result.rows;
}

async function getByLocation(id, lat, lon) {
  const result = await pool.query(
    'SELECT id, lat, lon, name, elev, time, pubkey FROM repeaters WHERE id = $1 AND lat = $2 AND lon = $3',
    [id, lat, lon]
  );
  return result.rows[0] || null;
}

async function getByPubkey(pubkey) {
  const result = await pool.query(
    'SELECT id, lat, lon, name, elev, time, pubkey FROM repeaters WHERE pubkey = $1 ORDER BY time DESC',
    [pubkey.toLowerCase()]
  );
  return result.rows;
}

async function upsert(id, lat, lon, name, elev, time, pubkey = null, region = null) {
  // Try with region column first, fallback if it doesn't exist
  let query;
  try {
    query = `
      INSERT INTO repeaters (id, lat, lon, name, elev, time, pubkey, region)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id, lat, lon)
      DO UPDATE SET
        name = EXCLUDED.name,
        elev = COALESCE(EXCLUDED.elev, repeaters.elev),
        time = EXCLUDED.time,
        pubkey = COALESCE(EXCLUDED.pubkey, repeaters.pubkey),
        region = COALESCE(EXCLUDED.region, repeaters.region),
        updated_at = CURRENT_TIMESTAMP
    `;
    const elevValue = elev !== null && elev !== undefined ? parseFloat(elev) : null;
    const pubkeyValue = pubkey ? pubkey.toLowerCase() : null;
    await pool.query(query, [id, lat, lon, name, elevValue, time, pubkeyValue, region]);
  } catch (e) {
    if (e.code === '42703') {
      // Region column doesn't exist yet, use old schema
      query = `
        INSERT INTO repeaters (id, lat, lon, name, elev, time, pubkey)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id, lat, lon)
        DO UPDATE SET
          name = EXCLUDED.name,
          elev = COALESCE(EXCLUDED.elev, repeaters.elev),
          time = EXCLUDED.time,
          pubkey = COALESCE(EXCLUDED.pubkey, repeaters.pubkey),
          updated_at = CURRENT_TIMESTAMP
      `;
      const elevValue = elev !== null && elev !== undefined ? parseFloat(elev) : null;
      const pubkeyValue = pubkey ? pubkey.toLowerCase() : null;
      await pool.query(query, [id, lat, lon, name, elevValue, time, pubkeyValue]);
    } else {
      throw e;
    }
  }
}

async function deleteStale(maxAgeDays) {
  const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    'DELETE FROM repeaters WHERE time < $1 RETURNING id',
    [cutoffTime]
  );
  return result.rows.length;
}

async function deleteByIdLatLon(id, lat, lon) {
  await pool.query(
    'DELETE FROM repeaters WHERE id = $1 AND lat = $2 AND lon = $3',
    [id, lat, lon]
  );
}

module.exports = {
  getAll,
  getById,
  getByLocation,
  getByPubkey,
  upsert,
  deleteStale,
  deleteByIdLatLon,
};
