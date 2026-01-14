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
  await pool.query(query, [name, geohash]);
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
  // Check if there's a recent miss (unobserved sample) for this driver+geohash+time
  // timeWindowMs defaults to 5 minutes (300000ms)
  const minTime = time - timeWindowMs;
  const maxTime = time + timeWindowMs;

  // Check if there's a recent unobserved sample for this driver+geohash+time
  // We check samples table to see if there's a miss that matches
  // Handle cases where drivers column might not exist
  let checkQuery, checkResult;
  try {
    // Try with both observed and drivers columns
    checkQuery = `
      SELECT COUNT(*) as miss_count
      FROM samples s
      WHERE LEFT(s.geohash, 6) = $2
        AND s.drivers = $1
        AND s.time >= $3
        AND s.time <= $4
        AND (s.observed = false OR s.path = '{}' OR s.path IS NULL OR array_length(s.path, 1) IS NULL)
    `;
    checkResult = await pool.query(checkQuery, [name, geohash, minTime, maxTime]);
  } catch (e) {
    if (e.code === '42703') {
      // Column doesn't exist - try different combinations
      try {
        // Try with observed column but without drivers column
        checkQuery = `
          SELECT COUNT(*) as miss_count
          FROM samples s
          WHERE LEFT(s.geohash, 6) = $2
            AND s.time >= $3
            AND s.time <= $4
            AND (s.observed = false OR s.path = '{}' OR s.path IS NULL OR array_length(s.path, 1) IS NULL)
        `;
        checkResult = await pool.query(checkQuery, [geohash, minTime, maxTime]);
        // If drivers column doesn't exist, we can't match by driver name
        // Return false since we can't verify the match
        return false;
      } catch (e2) {
        if (e2.code === '42703') {
          // Neither observed nor drivers columns exist
          checkQuery = `
            SELECT COUNT(*) as miss_count
            FROM samples s
            WHERE LEFT(s.geohash, 6) = $2
              AND s.time >= $3
              AND s.time <= $4
              AND (s.path = '{}' OR s.path IS NULL OR array_length(s.path, 1) IS NULL)
          `;
          checkResult = await pool.query(checkQuery, [geohash, minTime, maxTime]);
          // If drivers column doesn't exist, we can't match by driver name
          return false;
        } else {
          throw e2;
        }
      }
    } else {
      throw e;
    }
  }

  const missCount = parseInt(checkResult.rows[0]?.miss_count || 0);

  if (missCount === 0) {
    // No recent miss found for this driver+geohash+time
    return false;
  }

  // Check if there's a miss record in drivers table and convert it
  const updateQuery = `
    UPDATE drivers
    SET
      hit = hit + 1,
      miss = GREATEST(0, miss - 1),
      updated_at = CURRENT_TIMESTAMP
    WHERE name = $1 AND geohash = $2 AND miss > 0
  `;

  const updateResult = await pool.query(updateQuery, [name, geohash]);
  return updateResult.rowCount > 0;
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

module.exports = {
  incrementMiss,
  incrementHit,
  convertMissToHit,
  convertMissToHitIfRecent,
  getByDriver,
  getByGeohash,
  getAll,
  getStats,
};
