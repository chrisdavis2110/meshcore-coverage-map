/**
 * Path Utilities
 *
 * Centralized path parsing and normalization for MeshCore packet paths.
 * Adapted from pymc_console for meshcore-coverage-map.
 */

/**
 * Extract the 2-character prefix from a hash.
 * Handles both "0xNN" format (local hash) and full hex strings (neighbor hashes).
 */
function getHashPrefix(hash) {
  if (!hash) return null;
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2, 4).toUpperCase();
  }
  return hash.slice(0, 2).toUpperCase();
}

/**
 * Parse and normalize a path array.
 *
 * @param path - Raw path array (may be array or null)
 * @param localHash - Local node's hash (e.g., "0x19") - used to strip local from end
 * @returns { effective, original, hadLocal, effectiveLength } or null
 */
function parsePath(path, localHash) {
  if (!path || !Array.isArray(path) || path.length === 0) {
    return null;
  }

  // Normalize all prefixes to uppercase
  const original = path.map(p => String(p).toUpperCase());

  // Calculate local prefix if hash provided
  const localPrefix = localHash ? getHashPrefix(localHash) : null;

  // Check if path ends with local's prefix
  const lastElement = original[original.length - 1];
  const hadLocal = localPrefix !== null && lastElement === localPrefix;

  // Create effective path (strip local if present)
  const effective = hadLocal ? original.slice(0, -1) : [...original];

  return {
    effective,
    original,
    hadLocal,
    effectiveLength: effective.length,
  };
}

/**
 * Calculate the position of an element in the effective path.
 * Position 1 = last forwarder (closest to local), 2 = second-to-last, etc.
 *
 * @param index - 0-based index in effective path
 * @param effectiveLength - Length of effective path
 * @returns 1-indexed position from the end
 */
function getPositionFromIndex(index, effectiveLength) {
  return effectiveLength - index;
}

/**
 * Check if a prefix matches a hash.
 */
function prefixMatches(prefix, hash) {
  if (!hash) return false;
  const normalizedPrefix = prefix.toUpperCase();
  if (hash.startsWith('0x') || hash.startsWith('0X')) {
    return hash.slice(2, 4).toUpperCase() === normalizedPrefix;
  }
  return hash.slice(0, 2).toUpperCase() === normalizedPrefix;
}

module.exports = {
  getHashPrefix,
  parsePath,
  getPositionFromIndex,
  prefixMatches,
};
