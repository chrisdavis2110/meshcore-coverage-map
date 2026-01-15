/**
 * Geographic Utilities
 *
 * Shared geographic functions for mesh topology analysis.
 * Adapted from pymc_console for meshcore-coverage-map.
 */

/**
 * Distance thresholds for proximity scoring (in meters).
 * Tuned for LoRa mesh networks where links can span several kilometers.
 */
const PROXIMITY_BANDS = {
    VERY_CLOSE: 500,   // < 500m = 1.0
    CLOSE: 2000,       // < 2km = 0.8
    MEDIUM: 5000,      // < 5km = 0.6
    FAR: 10000,        // < 10km = 0.4
    VERY_FAR: 20000,   // < 20km = 0.2
    // > 20km = 0.1
  };

  /**
   * Calculate distance between two coordinates in meters using Haversine formula.
   *
   * @param lat1 - Latitude of first point (degrees)
   * @param lon1 - Longitude of first point (degrees)
   * @param lat2 - Latitude of second point (degrees)
   * @param lon2 - Longitude of second point (degrees)
   * @returns Distance in meters
   */
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Check if coordinates are valid (non-zero).
   */
  function hasValidCoordinates(lat, lon) {
    return lat !== undefined && lon !== undefined && lat !== null && lon !== null &&
      (lat !== 0 || lon !== 0);
  }

  module.exports = {
    PROXIMITY_BANDS,
    calculateDistance,
    hasValidCoordinates,
  };
