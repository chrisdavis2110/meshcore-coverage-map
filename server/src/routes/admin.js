const express = require('express');
const router = express.Router();
const samplesModel = require('../models/samples');
const repeatersModel = require('../models/repeaters');
const coverageModel = require('../models/coverage');
const archiveModel = require('../models/archive');
const { ageInDays, posFromHash, isValidLocation, haversineMiles } = require('../utils/shared');

// POST /consolidate?maxAge=<days>
router.post('/consolidate', async (req, res, next) => {
  try {
    // Default to 14 days (2 weeks) if not specified
    const defaultMaxAge = parseInt(process.env.CONSOLIDATE_MAX_AGE_DAYS) || 14;
    const maxAge = parseInt(req.query.maxAge) || defaultMaxAge;
    const result = {
      coverage_entites_to_update: 0,
      samples_to_update: 0,
      merged_ok: 0,
      merged_fail: 0,
      archive_ok: 0,
      archive_fail: 0,
      delete_ok: 0,
      delete_fail: 0,
      delete_skip: 0
    };
    
    // Get old samples
    const oldSamples = await samplesModel.getOlderThan(maxAge);
    result.samples_to_update = oldSamples.length;
    
    // Group by 6-char geohash
    const hashToSamples = new Map();
    oldSamples.forEach(sample => {
      const coverageHash = sample.geohash.substring(0, 6);
      if (!hashToSamples.has(coverageHash)) {
        hashToSamples.set(coverageHash, []);
      }
      hashToSamples.get(coverageHash).push({
        key: sample.geohash,
        time: sample.time,
        path: sample.path || []
      });
    });
    
    result.coverage_entites_to_update = hashToSamples.size;
    const mergedKeys = [];
    
    // Merge into coverage
    for (const [geohash, samples] of hashToSamples.entries()) {
      try {
        await coverageModel.mergeCoverage(geohash, samples);
        result.merged_ok++;
        mergedKeys.push(geohash);
      } catch (e) {
        console.log(`Merge failed for ${geohash}. ${e}`);
        result.merged_fail++;
      }
    }
    
    // Archive and delete
    for (const geohash of mergedKeys) {
      const samples = hashToSamples.get(geohash);
      for (const sample of samples) {
        try {
          await archiveModel.insert(sample.key, sample.time, sample.path);
          result.archive_ok++;
          
          try {
            await samplesModel.deleteByGeohash(sample.key);
            result.delete_ok++;
          } catch (e) {
            console.log(`Delete failed for ${sample.key}. ${e}`);
            result.delete_fail++;
          }
        } catch (e) {
          console.log(`Archive failed for ${sample.key}. ${e}`);
          result.archive_fail++;
          result.delete_skip++;
        }
      }
    }
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /clean-up?op=<coverage|samples|repeaters>
router.post('/clean-up', async (req, res, next) => {
  try {
    const op = req.query.op;
    const result = {};
    
    if (op === 'coverage') {
      result.coverage_deduped = 0;
      result.coverage_out_of_range = 0;
      
      const allCoverage = await coverageModel.getAll();
      
      for (const cov of allCoverage) {
        // Check if out of range
        const pos = posFromHash(cov.hash);
        if (!isValidLocation(pos)) {
          await coverageModel.deleteByGeohash(cov.hash);
          result.coverage_out_of_range++;
          continue;
        }
        
        // Deduplicate values
        try {
          await coverageModel.deduplicateValues(cov.hash);
          result.coverage_deduped++;
        } catch (e) {
          console.log(`Error deduplicating ${cov.hash}: ${e}`);
        }
      }
    } else if (op === 'samples') {
      result.sample_deleted = 0;
      
      // Delete samples from specific time range (service issue)
      const start = new Date('2025-12-06T07:00:00').getTime();
      const end = new Date('2025-12-07T16:30:00').getTime();
      const deleted = await samplesModel.deleteByTimeRange(start, end);
      result.sample_deleted = deleted;
    } else if (op === 'repeaters') {
      result.deleted_stale_repeaters = 0;
      result.deleted_dupe_repeaters = 0;
      
      // Delete stale repeaters (>10 days)
      const deletedStale = await repeatersModel.deleteStale(10);
      result.deleted_stale_repeaters = deletedStale;
      
      // Deduplicate by location (keep newest)
      const allRepeaters = await repeatersModel.getAll();
      const byId = new Map();
      
      allRepeaters.keys.forEach(r => {
        const id = r.metadata.id;
        if (!byId.has(id)) {
          byId.set(id, []);
        }
        byId.get(id).push(r);
      });
      
      // Group by location overlap
      for (const [id, repeaters] of byId.entries()) {
        const groups = groupByOverlap(repeaters);
        
        for (const group of groups) {
          if (group.items.length > 1) {
            // Keep newest, delete others
            const sorted = group.items.sort((a, b) => 
              b.metadata.time - a.metadata.time
            );
            
            for (let i = 1; i < sorted.length; i++) {
              const item = sorted[i];
              const [lat, lon] = item.name.split('|').slice(1).map(parseFloat);
              await repeatersModel.deleteByIdLatLon(id, lat, lon);
              result.deleted_dupe_repeaters++;
            }
          }
        }
      }
    }
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function overlaps(a, b) {
  const dist = haversineMiles(a, b);
  return dist <= 0.25; // 1/4 mile
}

function groupByOverlap(items) {
  const groups = [];
  
  for (const item of items) {
    const nameParts = item.name.split('|');
    const lat = parseFloat(nameParts[1]);
    const lon = parseFloat(nameParts[2]);
    const loc = [lat, lon];
    let found = false;
    
    for (const group of groups) {
      if (overlaps(group.loc, loc)) {
        group.items.push(item);
        found = true;
        break;
      }
    }
    
    if (!found) {
      groups.push({
        id: item.metadata.id,
        loc: loc,
        items: [item]
      });
    }
  }
  
  return groups;
}

module.exports = router;

