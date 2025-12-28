/**
 * Prefix Disambiguation System
 *
 * Resolves 2-character hex prefix collisions in MeshCore packet paths.
 * Adapted from pymc_console for meshcore-coverage-map.
 *
 * This simplified version works with:
 * - Repeaters (with prefix/id, lat, lon, time)
 * - Samples (with paths and geohash as source location)
 */

const { getHashPrefix, parsePath, getPositionFromIndex } = require('./path-utils');
const { calculateDistance, PROXIMITY_BANDS } = require('./geo-utils');
const { posFromHash } = require('./shared');

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const SCORE_WEIGHTS = {
  position: 0.15,
  cooccurrence: 0.15,
  geographic: 0.40,
  recency: 0.30,
};

const MAX_POSITIONS = 5;
const MAX_CANDIDATE_AGE_HOURS = 336; // 14 days
const RECENCY_DECAY_HOURS = 12;

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate recency score using exponential decay.
 */
function calculateRecencyScore(lastSeenTimestamp, nowTimestamp) {
  if (!lastSeenTimestamp || lastSeenTimestamp <= 0) {
    return 0.1;
  }

  const now = nowTimestamp ?? Math.floor(Date.now() / 1000);
  const hoursAgo = (now - lastSeenTimestamp) / 3600;

  if (hoursAgo < 0) {
    return 1.0; // Future timestamp (clock skew)
  }

  return Math.exp(-hoursAgo / RECENCY_DECAY_HOURS);
}

/**
 * Check if a candidate is too old to be considered.
 */
function isCandidateTooOld(lastSeenTimestamp) {
  if (!lastSeenTimestamp || lastSeenTimestamp <= 0) {
    return false; // Unknown age - don't filter
  }

  const now = Math.floor(Date.now() / 1000);
  const hoursAgo = (now - lastSeenTimestamp) / 3600;

  return hoursAgo > MAX_CANDIDATE_AGE_HOURS;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a prefix lookup table from samples and repeaters.
 *
 * @param samples - Array of sample objects with { name: geohash, metadata: { path, time } }
 * @param repeaters - Array of repeater objects with { metadata: { id, lat, lon, time } }
 * @param localHash - Optional local node hash (for stripping from paths)
 * @returns Map from prefix to disambiguation result
 */
function buildPrefixLookup(samples, repeaters, localHash) {
  const lookup = new Map();

  // ─── Step 1: Build prefix -> candidates mapping from repeaters ──────────────
  const prefixToCandidates = new Map();

  // Group repeaters by prefix
  const repeatersByPrefix = new Map();
  for (const repeater of repeaters) {
    const prefix = (repeater.metadata?.id || '').toUpperCase();
    if (!prefix || prefix.length !== 2) continue;

    const lastSeenTimestamp = repeater.metadata?.time
      ? Math.floor(repeater.metadata.time / 1000) // Convert ms to seconds
      : 0;

    // Skip candidates that are too old
    if (isCandidateTooOld(lastSeenTimestamp)) {
      continue;
    }

    if (!repeatersByPrefix.has(prefix)) {
      repeatersByPrefix.set(prefix, []);
    }
    repeatersByPrefix.get(prefix).push({
      prefix,
      lat: repeater.metadata?.lat,
      lon: repeater.metadata?.lon,
      time: lastSeenTimestamp,
      name: repeater.metadata?.name,
    });
  }

  // Create candidate objects for each repeater
  for (const [prefix, repeaterList] of repeatersByPrefix) {
    const candidates = repeaterList.map(repeater => {
      // Calculate geographic score based on distance (will be calculated later with local coords)
      const geoScore = 0.2; // Default

      const recencyScore = calculateRecencyScore(repeater.time);

      return {
        hash: prefix, // In this simplified model, we use prefix as hash
        prefix,
        positionCounts: new Array(MAX_POSITIONS).fill(0),
        totalAppearances: 0,
        typicalPosition: 0,
        positionConsistency: 0,
        adjacentPrefixCounts: new Map(),
        totalAdjacentObservations: 0,
        latitude: repeater.lat,
        longitude: repeater.lon,
        distanceToLocal: undefined,
        srcGeoEvidenceScore: 0,
        srcGeoEvidenceCount: 0,
        lastSeenTimestamp: repeater.time,
        recencyScore,
        positionScore: 0,
        cooccurrenceScore: 0,
        geographicScore: geoScore,
        combinedScore: 0,
      };
    });

    prefixToCandidates.set(prefix, candidates);
  }

  // ─── Step 2: Analyze samples for position and co-occurrence data ─────────────
  for (const sample of samples) {
    const path = sample.metadata?.path || [];
    if (!path || path.length === 0) continue;

    const parsed = parsePath(path, localHash);
    if (!parsed || parsed.effectiveLength === 0) continue;

    const effectivePath = parsed.effective;

    // Get source location from geohash
    let srcLat, srcLon;
    try {
      [srcLat, srcLon] = posFromHash(sample.name);
    } catch (e) {
      // Invalid geohash, skip
      continue;
    }

    // Process each element in the effective path
    for (let i = 0; i < effectivePath.length; i++) {
      const prefix = effectivePath[i];
      const candidates = prefixToCandidates.get(prefix);
      if (!candidates) continue;

      // Position: 1 = last element (direct forwarder), 2 = second-to-last, etc.
      const position = getPositionFromIndex(i, parsed.effectiveLength);
      const positionIndex = Math.min(position - 1, MAX_POSITIONS - 1);

      // Update position counts for all candidates matching this prefix
      for (const candidate of candidates) {
        candidate.positionCounts[positionIndex]++;
        candidate.totalAppearances++;

        // Source-geographic correlation for position 1
        if (position === 1 && candidates.length > 1 &&
            candidate.latitude && candidate.longitude) {
          const distToSrc = calculateDistance(
            srcLat, srcLon,
            candidate.latitude, candidate.longitude
          );

          let evidence = 0;
          if (distToSrc < 500) {
            evidence = 1.0;
          } else if (distToSrc < 2000) {
            evidence = 0.8;
          } else if (distToSrc < 5000) {
            evidence = 0.5;
          } else if (distToSrc < 10000) {
            evidence = 0.3;
          } else {
            evidence = 0.1;
          }

          candidate.srcGeoEvidenceScore += evidence;
          candidate.srcGeoEvidenceCount++;
        }

        // Track adjacent prefixes
        if (i > 0) {
          const prevPrefix = effectivePath[i - 1];
          candidate.adjacentPrefixCounts.set(
            prevPrefix,
            (candidate.adjacentPrefixCounts.get(prevPrefix) || 0) + 1
          );
          candidate.totalAdjacentObservations++;
        }
        if (i < effectivePath.length - 1) {
          const nextPrefix = effectivePath[i + 1];
          candidate.adjacentPrefixCounts.set(
            nextPrefix,
            (candidate.adjacentPrefixCounts.get(nextPrefix) || 0) + 1
          );
          candidate.totalAdjacentObservations++;
        }
      }
    }
  }

  // ─── Step 3: Calculate scores for each candidate ─────────────────────────────
  // Find max values for normalization
  let maxAppearances = 1;
  let maxAdjacentObs = 1;

  for (const candidates of prefixToCandidates.values()) {
    for (const c of candidates) {
      maxAppearances = Math.max(maxAppearances, c.totalAppearances);
      maxAdjacentObs = Math.max(maxAdjacentObs, c.totalAdjacentObservations);
    }
  }

  // Calculate scores for each candidate
  for (const candidates of prefixToCandidates.values()) {
    for (const candidate of candidates) {
      // Position score
      if (candidate.totalAppearances > 0) {
        let maxCount = 0;
        let typicalPos = 1;
        for (let i = 0; i < MAX_POSITIONS; i++) {
          if (candidate.positionCounts[i] > maxCount) {
            maxCount = candidate.positionCounts[i];
            typicalPos = i + 1;
          }
        }
        candidate.typicalPosition = typicalPos;
        candidate.positionConsistency = maxCount / candidate.totalAppearances;

        const frequencyScore = candidate.totalAppearances / maxAppearances;
        candidate.positionScore = candidate.positionConsistency * 0.6 + frequencyScore * 0.4;
      }

      // Co-occurrence score
      if (candidate.totalAdjacentObservations > 0) {
        candidate.cooccurrenceScore = candidate.totalAdjacentObservations / maxAdjacentObs;
      }

      // Geographic score (will be updated if we have local coords)
      // Recency score is pre-calculated

      // Combined score
      candidate.combinedScore =
        candidate.positionScore * SCORE_WEIGHTS.position +
        candidate.cooccurrenceScore * SCORE_WEIGHTS.cooccurrence +
        candidate.geographicScore * SCORE_WEIGHTS.geographic +
        candidate.recencyScore * SCORE_WEIGHTS.recency;

      // Source-geographic evidence boost
      if (candidate.srcGeoEvidenceCount > 0) {
        const avgEvidence = candidate.srcGeoEvidenceScore / candidate.srcGeoEvidenceCount;
        const observationWeight = Math.min(candidate.srcGeoEvidenceCount / 50, 1);
        const srcGeoBoost = avgEvidence * observationWeight * 0.3;
        candidate.combinedScore += srcGeoBoost;
      }
    }
  }

  // ─── Step 4: Build disambiguation results ────────────────────────────────────
  for (const [prefix, candidates] of prefixToCandidates) {
    // Sort by combined score descending
    candidates.sort((a, b) => b.combinedScore - a.combinedScore);

    const bestMatch = candidates.length > 0 ? candidates[0].hash : null;

    // Calculate confidence
    let confidence = 0;
    if (candidates.length === 1) {
      confidence = 1;
    } else if (candidates.length > 1) {
      const best = candidates[0].combinedScore;
      const second = candidates[1].combinedScore;
      if (best > 0) {
        confidence = Math.min(1, (best - second) / best);
      }
      if (candidates[0].totalAppearances > candidates[1].totalAppearances * 2) {
        confidence = Math.min(1, confidence + 0.2);
      }
    }

    lookup.set(prefix, {
      prefix,
      candidates,
      bestMatch,
      confidence,
      isUnambiguous: candidates.length === 1,
    });
  }

  return lookup;
}

/**
 * Resolve a prefix to the best matching hash using the lookup table.
 *
 * @param lookup - The prefix lookup table
 * @param prefix - The 2-char prefix to resolve
 * @returns { hash, confidence } or { hash: null, confidence: 0 }
 */
function resolvePrefix(lookup, prefix) {
  const normalized = prefix.toUpperCase();
  const result = lookup.get(normalized);

  if (!result || result.candidates.length === 0) {
    return { hash: null, confidence: 0 };
  }

  return { hash: result.bestMatch, confidence: result.confidence };
}

/**
 * Disambiguate a path array using the lookup table.
 *
 * @param lookup - The prefix lookup table
 * @param path - Array of 2-char prefixes
 * @returns Array of resolved hashes (or original prefix if not found)
 */
function disambiguatePath(lookup, path) {
  if (!path || !Array.isArray(path)) {
    return path;
  }

  return path.map(prefix => {
    const resolved = resolvePrefix(lookup, prefix);
    return resolved.hash || prefix;
  });
}

module.exports = {
  buildPrefixLookup,
  resolvePrefix,
  disambiguatePath,
  getHashPrefix,
};
