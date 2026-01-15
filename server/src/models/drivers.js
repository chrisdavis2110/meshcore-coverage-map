const pool = require('../config/database');

async function incrementMiss(name, geohash) {
  const query = `
    INSERT INTO drivers (name, geohash, miss)
    VALUES ($1, $2, 1)
    ON CONFLICT (name, geohash)
    DO UPDATE SET
      miss = drivers.miss + 1,
      updated_at = CURRENT_TIMESTAMP
  `;
  await pool.query(query, [name, geohash]);
}

async function incrementHit(name, geohash) {
  const query = `
    INSERT INTO drivers (name, geohash, hit)
    VALUES ($1, $2, 1)
    ON CONFLICT (name, geohash)
    DO UPDATE SET
      hit = drivers.hit + 1,
      updated_at = CURRENT_TIMESTAMP
  `;
  const result = await pool.query(query, [name, geohash]);
  console.log(`[DRIVER INCREMENT HIT] Updated hit for ${name} at ${geohash}, rows affected: ${result.rowCount}`);
  return result;
}

async function convertMissToHit(name, geohash) {
  const query = `
    INSERT INTO drivers (name, geohash, hit, miss)
    VALUES ($1, $2, 1, 0)
    ON CONFLICT (name, geohash)
    DO UPDATE SET
      hit = drivers.hit + 1,
      miss = GREATEST(0, drivers.miss - 1),
      updated_at = CURRENT_TIMESTAMP
  `;
  await pool.query(query, [name, geohash]);
}

async function convertMissToHitIfRecent(name, geohash, time, timeWindowMs = 300000) {
  // Check if there's a recent miss in the drivers table for this driver+geohash
  // We check the drivers table directly since misses are recorded there immediately
  // when a ping is sent via /update-driver-miss

  // First check if there's a miss record in the drivers table
  const checkQuery = `
    SELECT miss, hit FROM drivers
    WHERE name = $1 AND geohash = $2
  `;
  const checkResult = await pool.query(checkQuery, [name, geohash]);

  if (checkResult.rows.length === 0) {
    // No record exists - can't convert
    console.log(`[DRIVER CONVERT] No record found for ${name} at ${geohash}`);
    return false;
  }

  const currentMiss = checkResult.rows[0].miss || 0;
  const currentHit = checkResult.rows[0].hit || 0;
  console.log(`[DRIVER CONVERT] Current state - miss: ${currentMiss}, hit: ${currentHit} for ${name} at ${geohash}`);

  if (currentMiss === 0) {
    // No miss to convert
    console.log(`[DRIVER CONVERT] No miss to convert (miss=${currentMiss})`);
    return false;
  }

  // Check if there's a miss record in the drivers table for this driver+geohash
  // The geohash is already 6-char (from coverageKey), so it matches the drivers table
  const updateQuery = `
    UPDATE drivers
    SET
      hit = hit + 1,
      miss = GREATEST(0, miss - 1),
      updated_at = CURRENT_TIMESTAMP
    WHERE name = $1 AND geohash = $2 AND miss > 0
  `;

  const updateResult = await pool.query(updateQuery, [name, geohash]);
  const converted = updateResult.rowCount > 0;
  console.log(`[DRIVER CONVERT] Update result - converted: ${converted}, rows: ${updateResult.rowCount}`);
  return converted;
}

async function getByDriver(name) {
  const result = await pool.query(
    'SELECT name, geohash, hit, miss, created_at, updated_at FROM drivers WHERE name = $1 ORDER BY geohash',
    [name]
  );
  return result.rows;
}

async function getByGeohash(geohash) {
  const result = await pool.query(
    'SELECT name, geohash, hit, miss, created_at, updated_at FROM drivers WHERE geohash = $1 ORDER BY name',
    [geohash]
  );
  return result.rows;
}

async function getAll() {
  const result = await pool.query(
    'SELECT name, geohash, hit, miss, created_at, updated_at FROM drivers ORDER BY name, geohash'
  );
  return result.rows;
}

async function getStats(name) {
  const result = await pool.query(
    `SELECT
      SUM(hit) as total_hits,
      SUM(miss) as total_misses,
      COUNT(*) as total_tiles
    FROM drivers
    WHERE name = $1`,
    [name]
  );
  return result.rows[0] || { total_hits: 0, total_misses: 0, total_tiles: 0 };
}

async function upsert(name, geohash, hit, miss) {
  const query = `
    INSERT INTO drivers (name, geohash, hit, miss)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (name, geohash)
    DO UPDATE SET
      hit = EXCLUDED.hit,
      miss = EXCLUDED.miss,
      updated_at = CURRENT_TIMESTAMP
  `;
  await pool.query(query, [name, geohash, hit || 0, miss || 0]);
}

module.exports = {
  incrementMiss,
  incrementHit,
  convertMissToHit,
  convertMissToHitIfRecent,
  getByDriver,
  getByGeohash,
  getAll,
  getStats,
  upsert,
};
