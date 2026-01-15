const pool = require('../config/database');
const { sampleKey, coverageKey } = require('../utils/shared');

async function getByPrefix(prefix) {
  // Try new schema first, fallback to old if columns don't exist
  let query, result;
  try {
    query = prefix
      ? 'SELECT geohash, time, path, observed, snr, rssi, drivers FROM samples WHERE geohash LIKE $1 ORDER BY geohash'
      : 'SELECT geohash, time, path, observed, snr, rssi, drivers FROM samples ORDER BY geohash';
    const params = prefix ? [`${prefix}%`] : [];
    result = await pool.query(query, params);
  } catch (error) {
    if (error.code === '42703') { // column does not exist
      try {
        query = prefix
          ? 'SELECT geohash, time, path, observed, snr, rssi FROM samples WHERE geohash LIKE $1 ORDER BY geohash'
          : 'SELECT geohash, time, path, observed, snr, rssi FROM samples ORDER BY geohash';
        const params = prefix ? [`${prefix}%`] : [];
        result = await pool.query(query, params);
      } catch (error2) {
        if (error2.code === '42703') {
          query = prefix
            ? 'SELECT geohash, time, path FROM samples WHERE geohash LIKE $1 ORDER BY geohash'
            : 'SELECT geohash, time, path FROM samples ORDER BY geohash';
          const params = prefix ? [`${prefix}%`] : [];
          result = await pool.query(query, params);
        } else {
          throw error2;
        }
      }
    } else {
      throw error;
    }
  }

  return {
    keys: result.rows.map(row => ({
      name: row.geohash,
      metadata: {
        time: row.time,
        path: row.path || [],
        observed: row.observed ?? (row.path && row.path.length > 0),
        snr: row.snr ?? null,
        rssi: row.rssi ?? null,
        drivers: row.drivers ?? null
      }
    }))
  };
}

async function getAll() {
  let result;
  try {
    result = await pool.query('SELECT geohash, time, path, observed, snr, rssi, drivers FROM samples ORDER BY geohash');
  } catch (error) {
    if (error.code === '42703') { // column does not exist
      try {
        result = await pool.query('SELECT geohash, time, path, observed, snr, rssi FROM samples ORDER BY geohash');
      } catch (error2) {
        if (error2.code === '42703') {
          result = await pool.query('SELECT geohash, time, path FROM samples ORDER BY geohash');
        } else {
          throw error2;
        }
      }
    } else {
      throw error;
    }
  }

  return {
    keys: result.rows.map(row => ({
      name: row.geohash,
      metadata: {
        time: row.time,
        path: row.path || [],
        observed: row.observed ?? (row.path && row.path.length > 0),
        snr: row.snr ?? null,
        rssi: row.rssi ?? null,
        drivers: row.drivers ?? null
      }
    }))
  };
}

async function getWithMetadata(geohash) {
  let result;
  try {
    result = await pool.query(
      'SELECT geohash, time, path, observed, snr, rssi, drivers FROM samples WHERE geohash = $1',
      [geohash]
    );
  } catch (error) {
    if (error.code === '42703') { // column does not exist
      try {
        result = await pool.query(
          'SELECT geohash, time, path, observed, snr, rssi FROM samples WHERE geohash = $1',
          [geohash]
        );
      } catch (error2) {
        if (error2.code === '42703') {
          result = await pool.query(
            'SELECT geohash, time, path FROM samples WHERE geohash = $1',
            [geohash]
          );
        } else {
          throw error2;
        }
      }
    } else {
      throw error;
    }
  }

  if (result.rows.length === 0) {
    return { value: null, metadata: null };
  }

  const row = result.rows[0];
  return {
    value: '',
    metadata: {
      time: row.time,
      path: row.path || [],
      observed: row.observed ?? (row.path && row.path.length > 0),
      snr: row.snr ?? null,
      rssi: row.rssi ?? null,
      drivers: row.drivers ?? null
    }
  };
}

async function upsert(geohash, time, path, observed = null, snr = null, rssi = null, drivers = null) {
  // Normalize observed: if null, derive from path
  const normalizedObserved = observed ?? (path && path.length > 0);

  // Try new schema first, fallback to old if columns don't exist
  let query;
  try {
    query = `
      INSERT INTO samples (geohash, time, path, observed, snr, rssi, drivers)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (geohash)
      DO UPDATE SET
        time = GREATEST(samples.time, EXCLUDED.time),
        path = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(ARRAY_CAT(COALESCE(samples.path, '{}'), EXCLUDED.path))
            ORDER BY 1
          )
        ),
        observed = COALESCE(EXCLUDED.observed, samples.observed) OR COALESCE(samples.observed, EXCLUDED.observed, false),
        snr = CASE
          WHEN EXCLUDED.snr IS NULL THEN samples.snr
          WHEN samples.snr IS NULL THEN EXCLUDED.snr
          ELSE GREATEST(EXCLUDED.snr, samples.snr)
        END,
        rssi = CASE
          WHEN EXCLUDED.rssi IS NULL THEN samples.rssi
          WHEN samples.rssi IS NULL THEN EXCLUDED.rssi
          ELSE GREATEST(EXCLUDED.rssi, samples.rssi)
        END,
        drivers = CASE
          -- Simple logic: Wardrive always sends drivers, MQTT never sends drivers
          -- If new drivers is provided (wardrive) → use it
          -- If new drivers is NULL (MQTT) → preserve existing drivers
          WHEN EXCLUDED.drivers IS NOT NULL AND EXCLUDED.drivers != '' THEN EXCLUDED.drivers
          WHEN samples.drivers IS NOT NULL AND samples.drivers != '' THEN samples.drivers
          ELSE NULL
        END,
        updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(query, [geohash, time, path, normalizedObserved, snr, rssi, drivers]);
  } catch (error) {
    if (error.code === '42703') { // column does not exist - try without drivers
      try {
        query = `
          INSERT INTO samples (geohash, time, path, observed, snr, rssi)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (geohash)
          DO UPDATE SET
            time = GREATEST(samples.time, EXCLUDED.time),
            path = (
              SELECT ARRAY(
                SELECT DISTINCT unnest(ARRAY_CAT(COALESCE(samples.path, '{}'), EXCLUDED.path))
                ORDER BY 1
              )
            ),
            observed = COALESCE(EXCLUDED.observed, samples.observed) OR COALESCE(samples.observed, EXCLUDED.observed, false),
            snr = CASE
              WHEN EXCLUDED.snr IS NULL THEN samples.snr
              WHEN samples.snr IS NULL THEN EXCLUDED.snr
              ELSE GREATEST(EXCLUDED.snr, samples.snr)
            END,
            rssi = CASE
              WHEN EXCLUDED.rssi IS NULL THEN samples.rssi
              WHEN samples.rssi IS NULL THEN EXCLUDED.rssi
              ELSE GREATEST(EXCLUDED.rssi, samples.rssi)
            END,
            updated_at = CURRENT_TIMESTAMP
        `;
        await pool.query(query, [geohash, time, path, normalizedObserved, snr, rssi]);
      } catch (error2) {
        if (error2.code === '42703') {
          // Oldest schema - no observed, snr, rssi, drivers
          query = `
            INSERT INTO samples (geohash, time, path)
            VALUES ($1, $2, $3)
            ON CONFLICT (geohash)
            DO UPDATE SET
              time = GREATEST(samples.time, EXCLUDED.time),
              path = (
                SELECT ARRAY(
                  SELECT DISTINCT unnest(ARRAY_CAT(COALESCE(samples.path, '{}'), EXCLUDED.path))
                  ORDER BY 1
                )
              ),
              updated_at = CURRENT_TIMESTAMP
          `;
          await pool.query(query, [geohash, time, path]);
        } else {
          throw error2;
        }
      }
    } else {
      throw error;
    }
  }
}

async function deleteByGeohash(geohash) {
  await pool.query('DELETE FROM samples WHERE geohash = $1', [geohash]);
}

async function getOlderThan(maxAgeDays) {
  const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  let result;
  try {
    result = await pool.query(
      'SELECT geohash, time, path, observed, snr, rssi, drivers FROM samples WHERE time < $1 ORDER BY geohash',
      [cutoffTime]
    );
  } catch (error) {
    if (error.code === '42703') {
      try {
        result = await pool.query(
          'SELECT geohash, time, path, observed, snr, rssi FROM samples WHERE time < $1 ORDER BY geohash',
          [cutoffTime]
        );
      } catch (error2) {
        if (error2.code === '42703') {
          result = await pool.query(
            'SELECT geohash, time, path FROM samples WHERE time < $1 ORDER BY geohash',
            [cutoffTime]
          );
        } else {
          throw error2;
        }
      }
    } else {
      throw error;
    }
  }
  return result.rows.map(row => ({
    geohash: row.geohash,
    time: row.time,
    path: row.path || [],
    observed: row.observed ?? (row.path && row.path.length > 0),
    snr: row.snr,
    rssi: row.rssi,
    drivers: row.drivers ?? null
  }));
}

async function deleteByTimeRange(startTime, endTime) {
  const result = await pool.query(
    'DELETE FROM samples WHERE time >= $1 AND time <= $2 RETURNING geohash',
    [startTime, endTime]
  );
  return result.rows.length;
}

module.exports = {
  getByPrefix,
  getAll,
  getWithMetadata,
  upsert,
  deleteByGeohash,
  getOlderThan,
  deleteByTimeRange,
};
