import {
  ageInDays,
  centerPos,
  geo,
  haversineMiles,
  loadConfig,
  maxDistanceMiles,
  posFromHash,
  pushMap,
  sigmoid,
  fromTruncatedTime,
} from './shared.js'

// Global Init - map will be initialized after config loads
let map = null;
let osm = null;

// Control state
let repeaterRenderMode = 'all';
let repeaterSearch = '';
let showSamples = false;

// Data
let nodes = null; // Graph data from the last refresh
let idToRepeaters = null; // Index of pubkey (or id if no pubkey) -> [repeater]
let idToRepeatersById = null; // Index of 2-char id -> [repeater] for matching coverage.rptr
let hashToCoverage = null; // Index of geohash -> coverage
let edgeList = null; // List of connected repeater and coverage
let individualSamples = null; // Individual (non-aggregated) samples
let driverFilters = {}; // Driver filter state

// Map layers (will be initialized after map is created)
let coverageLayer = null;
let edgeLayer = null;
let sampleLayer = null;
let repeaterLayer = null;

// Map controls (must be added first so Top Repeaters appears below)
const mapControl = L.control({ position: 'topright' });
mapControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div class="mesh-control-row">
      <label>
        Repeaters:
        <select id="repeater-filter-select">
          <option value="all" selected="true">All</option>
          <option value="hit">Hit</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Find Id:
        <input type="text" id="repeater-search" />
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Show Samples:
        <input type="checkbox" id="show-samples" />
      </label>
    </div>
    <div class="mesh-control-row">
      <button type="button" id="refresh-map-button">Refresh map</button>
    </div>
  `;

  div.querySelector("#repeater-filter-select")
    .addEventListener("change", (e) => {
      repeaterRenderMode = e.target.value;
      updateAllRepeaterMarkers();
    });

  div.querySelector("#repeater-search")
    .addEventListener("input", (e) => {
      repeaterSearch = e.target.value.toLowerCase();
      updateAllRepeaterMarkers();
    });

  div.querySelector("#show-samples")
    .addEventListener("change", async (e) => {
      showSamples = e.target.checked;
      if (showSamples) {
        // Fetch and display all individual samples
        await loadIndividualSamples();
      } else {
        // Clear individual samples and show aggregated view
        clearIndividualSamples();
        // Re-render with aggregated samples from nodes
        if (nodes) {
          renderNodes(nodes);
        }
      }
    });

  div.querySelector("#refresh-map-button")
    .addEventListener("click", () => refreshCoverage());

  // Don't let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};

// Repeaters list control (top-right corner, below existing controls)
const repeatersControl = L.control({ position: 'topright' });
repeatersControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'leaflet-control');
  div.style.marginTop = '10px'; // Space below existing control box
  div.innerHTML = `
    <button id="repeaters-button" style="
      background: #4a5568;
      color: white;
      border: 1px solid #718096;
      border-radius: 4px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      white-space: nowrap;
      width: 100%;
      margin-bottom: 4px;
    ">Top Repeaters</button>
    <button id="drivers-button" style="
      background: #4a5568;
      color: white;
      border: 1px solid #718096;
      border-radius: 4px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      white-space: nowrap;
      width: 100%;
    ">Top Drivers</button>
    <div id="repeaters-list" style="
      display: none;
      margin-top: 4px;
      background: #2d3748;
      border: 1px solid #4a5568;
      border-radius: 4px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
      max-height: 500px;
      overflow-y: auto;
    ">
      <div style="padding: 12px; background: #1a202c; border-bottom: 1px solid #4a5568; font-weight: 600; color: #e2e8f0; position: sticky; top: 0;">
        Repeaters by Coverage
      </div>
      <div id="repeaters-list-content" style="padding: 0;"></div>
    </div>
    <div id="drivers-list" style="
      display: none;
      margin-top: 4px;
      background: #2d3748;
      border: 1px solid #4a5568;
      border-radius: 4px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
      max-height: 500px;
      overflow-y: auto;
    ">
      <div style="padding: 12px; background: #1a202c; border-bottom: 1px solid #4a5568; font-weight: 600; color: #e2e8f0; position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center;">
        <span>Drivers by Samples</span>
        <button id="drivers-filter-btn" style="
          background: #4a5568;
          color: white;
          border: 1px solid #718096;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        ">Filter</button>
      </div>
      <div id="drivers-filter-panel" style="
        display: none;
        padding: 12px;
        background: #1a202c;
        border-bottom: 1px solid #4a5568;
      ">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Min Samples</label>
            <input type="number" id="filter-min-count" placeholder="0" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Max Samples</label>
            <input type="number" id="filter-max-count" placeholder="∞" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Min Hits</label>
            <input type="number" id="filter-min-heard" placeholder="0" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Max Hits</label>
            <input type="number" id="filter-max-heard" placeholder="∞" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Min Misses</label>
            <input type="number" id="filter-min-lost" placeholder="0" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Max Misses</label>
            <input type="number" id="filter-max-lost" placeholder="∞" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Min %</label>
            <input type="number" id="filter-min-percent" placeholder="0" min="0" max="100" step="0.1" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px;">Max %</label>
            <input type="number" id="filter-max-percent" placeholder="100" min="0" max="100" step="0.1" style="
              width: 100%;
              padding: 4px 6px;
              background: #2d3748;
              border: 1px solid #4a5568;
              border-radius: 4px;
              color: #e2e8f0;
              font-size: 12px;
            ">
          </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <select id="filter-sort-by" style="
            flex: 1;
            padding: 4px 6px;
            background: #2d3748;
            border: 1px solid #4a5568;
            border-radius: 4px;
            color: #e2e8f0;
            font-size: 12px;
          ">
            <option value="count">Sort by Count</option>
            <option value="heard">Sort by Hits</option>
            <option value="lost">Sort by Misses</option>
            <option value="percent">Sort by %</option>
          </select>
          <select id="filter-sort-order" style="
            padding: 4px 6px;
            background: #2d3748;
            border: 1px solid #4a5568;
            border-radius: 4px;
            color: #e2e8f0;
            font-size: 12px;
          ">
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button id="drivers-filter-apply" style="
            flex: 1;
            padding: 6px 12px;
            background: #4a5568;
            color: white;
            border: 1px solid #718096;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
          ">Apply</button>
          <button id="drivers-filter-clear" style="
            flex: 1;
            padding: 6px 12px;
            background: #4a5568;
            color: white;
            border: 1px solid #718096;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
          ">Clear</button>
        </div>
      </div>
      <div id="drivers-list-content" style="padding: 0;"></div>
    </div>
  `;

  const repeatersButton = div.querySelector("#repeaters-button");
  const repeatersList = div.querySelector("#repeaters-list");
  const repeatersContent = div.querySelector("#repeaters-list-content");
  const driversButton = div.querySelector("#drivers-button");
  const driversList = div.querySelector("#drivers-list");
  const driversContent = div.querySelector("#drivers-list-content");

  repeatersButton.addEventListener("click", (e) => {
    e.stopPropagation();
    driversList.style.display = "none"; // Close drivers list
    if (repeatersList.style.display === "none") {
      updateRepeatersList(repeatersContent);
      repeatersList.style.display = "block";
    } else {
      repeatersList.style.display = "none";
    }
  });

  driversButton.addEventListener("click", (e) => {
    e.stopPropagation();
    repeatersList.style.display = "none"; // Close repeaters list
    if (driversList.style.display === "none") {
      updateDriversList(driversContent);
      driversList.style.display = "block";
    } else {
      driversList.style.display = "none";
    }
  });

  // Filter button handlers
  const driversFilterBtn = div.querySelector("#drivers-filter-btn");
  const driversFilterPanel = div.querySelector("#drivers-filter-panel");
  const driversFilterApply = div.querySelector("#drivers-filter-apply");
  const driversFilterClear = div.querySelector("#drivers-filter-clear");

  if (driversFilterBtn) {
    driversFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = driversFilterPanel.style.display !== "none";
      driversFilterPanel.style.display = isVisible ? "none" : "block";
    });
  }

  if (driversFilterApply) {
    driversFilterApply.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Collect filter values
      driverFilters = {
        minCount: document.getElementById("filter-min-count")?.value || null,
        maxCount: document.getElementById("filter-max-count")?.value || null,
        minHeard: document.getElementById("filter-min-heard")?.value || null,
        maxHeard: document.getElementById("filter-max-heard")?.value || null,
        minLost: document.getElementById("filter-min-lost")?.value || null,
        maxLost: document.getElementById("filter-max-lost")?.value || null,
        minPercent: document.getElementById("filter-min-percent")?.value || null,
        maxPercent: document.getElementById("filter-max-percent")?.value || null,
        sortBy: document.getElementById("filter-sort-by")?.value || "count",
        sortOrder: document.getElementById("filter-sort-order")?.value || "desc"
      };

      // Remove null/empty values
      Object.keys(driverFilters).forEach(key => {
        if (driverFilters[key] === null || driverFilters[key] === "") {
          delete driverFilters[key];
        }
      });

      // Refresh data with filters
      await refreshCoverage();
      updateDriversList(driversContent);
    });
  }

  if (driversFilterClear) {
    driversFilterClear.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Clear all filter inputs
      const inputs = ["filter-min-count", "filter-max-count", "filter-min-heard", "filter-max-heard",
                     "filter-min-lost", "filter-max-lost", "filter-min-percent", "filter-max-percent"];
      inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      const sortBy = document.getElementById("filter-sort-by");
      const sortOrder = document.getElementById("filter-sort-order");
      if (sortBy) sortBy.value = "count";
      if (sortOrder) sortOrder.value = "desc";

      // Clear filter state and refresh
      driverFilters = {};
      await refreshCoverage();
      updateDriversList(driversContent);
    });
  }

  // Close when clicking outside (use the map parameter 'm' passed to onAdd)
  const closeHandler = () => {
    repeatersList.style.display = "none";
    driversList.style.display = "none";
  };
  m.on("click", closeHandler);

  // Prevent clicks inside the lists from closing them
  repeatersList.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  driversList.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};
// Initialization function - loads config and sets up map
async function initMap() {
  // Load config from server
  await loadConfig();

  // Initialize map with configured center position
  map = L.map('map', { worldCopyJump: true }).setView(centerPos, 10);

  // Create and add tile layer
  osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors | <a href="/howto" target="_blank">Contribute</a>'
  }).addTo(map);

  // Create map layers
  coverageLayer = L.layerGroup().addTo(map);
  edgeLayer = L.layerGroup().addTo(map);
  sampleLayer = L.layerGroup().addTo(map);
  repeaterLayer = L.layerGroup().addTo(map);

  // Add controls
  mapControl.addTo(map);
  repeatersControl.addTo(map);

  // Max radius circle (only show if distance limit is enabled)
  if (maxDistanceMiles > 0) {
    L.circle(centerPos, {
      radius: maxDistanceMiles * 1609.34, // meters in mile
      color: '#a13139',
      weight: 3,
      fill: false
    }).addTo(map);
  }

  // Load initial data
  await refreshCoverage();
}

// Initialize on load - wait for DOM and handle errors
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initMap().catch(err => {
      console.error('Failed to initialize map:', err);
      // Show error to user
      const mapDiv = document.getElementById('map');
      if (mapDiv) {
        mapDiv.innerHTML = `<div style="padding: 20px; color: red;">Failed to load map: ${err.message}</div>`;
      }
    });
  });
} else {
  // DOM is already ready
  initMap().catch(err => {
    console.error('Failed to initialize map:', err);
    // Show error to user
    const mapDiv = document.getElementById('map');
    if (mapDiv) {
      mapDiv.innerHTML = `<div style="padding: 20px; color: red;">Failed to load map: ${err.message}</div>`;
    }
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Convert success rate (0-1) to a color gradient:
// Dark green (100%) -> Light green -> Orange -> Red-orange -> Red (0%)
function successRateToColor(rate) {
  // Clamp rate to 0-1
  const clampedRate = Math.max(0, Math.min(1, rate));

  let red, green, blue;

  if (clampedRate >= 0.75) {
    // Dark green (0, 100, 0) to lighter green (50, 150, 50) (75-100%)
    // Making light green closer to dark green
    const t = (clampedRate - 0.75) / 0.25; // 0 to 1
    red = Math.round(0 + (50 - 0) * t);     // 0 -> 50
    green = Math.round(100 + (150 - 100) * t); // 100 -> 150
    blue = Math.round(0 + (50 - 0) * t);    // 0 -> 50
  } else if (clampedRate >= 0.5) {
    // Light green (50, 150, 50) to orange (255, 165, 0) (50-75%)
    const t = (clampedRate - 0.5) / 0.25; // 0 to 1
    red = Math.round(50 + (255 - 50) * t);   // 50 -> 255
    green = Math.round(150 + (165 - 150) * t); // 150 -> 165
    blue = Math.round(50 - 50 * t);           // 50 -> 0
  } else if (clampedRate >= 0.25) {
    // Orange (255, 165, 0) to red-orange (255, 100, 0) (25-50%)
    const t = (clampedRate - 0.25) / 0.25; // 0 to 1
    red = 255;                                    // 255
    green = Math.round(165 + (100 - 165) * t);    // 165 -> 100
    blue = 0;                                      // 0
  } else {
    // Red-orange (255, 100, 0) to red (255, 0, 0) (0-25%)
    const t = clampedRate / 0.25; // 0 to 1
    red = 255;                                    // 255
    green = Math.round(100 - 100 * t);            // 100 -> 0
    blue = 0;                                      // 0
  }

  // Convert to hex
  const toHex = (n) => {
    const hex = n.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function coverageMarker(coverage) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(coverage.id);
  const totalSamples = coverage.rcv + coverage.lost;
  const heardRatio = totalSamples > 0 ? coverage.rcv / totalSamples : 0;
  // Use gradient color based on success rate
  const color = successRateToColor(heardRatio);
  const date = new Date(fromTruncatedTime(coverage.time || 0));
  // Ensure tiles with only lost samples are visible
  // Base opacity on total samples, but ensure minimum visibility for lost-only tiles
  const baseOpacity = 0.75 * sigmoid(totalSamples, 1.2, 2);
  // For tiles with only lost samples, use higher minimum opacity
  const opacity = heardRatio > 0
    ? baseOpacity * heardRatio
    : Math.max(baseOpacity, 0.4); // At least 40% opacity for lost-only tiles
  const style = {
    color: color,
    weight: 1,
    fillOpacity: Math.max(opacity, 0.2), // Minimum 20% opacity for all tiles
  };
  const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
  let details = `
    <strong>${coverage.id}</strong><br/>
    Heard: ${coverage.rcv} Lost: ${coverage.lost} (${(100 * heardRatio).toFixed(0)}%)<br/>
    Updated: ${date.toLocaleString()}`;
  if (coverage.rptr && coverage.rptr.length > 0) {
    // Display repeater IDs in uppercase for readability
    details += `<br/>Repeaters: ${coverage.rptr.map(r => r.toUpperCase()).join(',')}`;
  }
  if (coverage.snr !== null && coverage.snr !== undefined) {
    details += `<br/>SNR: ${coverage.snr} dB`;
  }
  if (coverage.rssi !== null && coverage.rssi !== undefined) {
    details += `<br/>RSSI: ${coverage.rssi} dBm`;
  }

  rect.coverage = coverage;
  rect.bindPopup(details, { maxWidth: 320 });
  rect.on('popupopen', e => updateAllEdgeVisibility(e.target.coverage));
  rect.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    rect.on('mouseover', e => updateAllEdgeVisibility(e.target.coverage));
    rect.on('mouseout', () => updateAllEdgeVisibility());
  }

  coverage.marker = rect;
  return rect;
}

function sampleMarker(s) {
  const [lat, lon] = posFromHash(s.id);
  // Use success rate to determine color (gradient from red 0% to green 100%)
  const successRate = s.successRate ?? (s.total > 0 ? s.heard / s.total : 0);
  const color = successRateToColor(successRate);
  // Scale marker size based on number of samples (min 5, max 15)
  const radius = Math.min(Math.max(5, Math.sqrt(s.total || 1) * 2), 15);
  const style = {
    radius: radius,
    weight: 2,
    color: color,
    fillColor: color,
    fillOpacity: 0.7
  };
  const marker = L.circleMarker([lat, lon], style);
  const date = new Date(fromTruncatedTime(s.time));
  const successPercent = (successRate * 100).toFixed(1);
  const repeaters = s.rptr || [];
  let details = `
    <strong>${s.id}</strong><br/>
    ${lat.toFixed(4)}, ${lon.toFixed(4)}<br/>
    Samples: ${s.total || 0} (${s.heard || 0} heard, ${s.lost || 0} lost)<br/>
    Success Rate: ${successPercent}%<br/>`;
  if (repeaters.length > 0) {
    details += `<br/>Repeaters: ${repeaters.join(', ')}`;
  }
  if (s.snr !== null && s.snr !== undefined) {
    details += `<br/>SNR: ${s.snr} dB`;
  }
  if (s.rssi !== null && s.rssi !== undefined) {
    details += `<br/>RSSI: ${s.rssi} dBm`;
  }
  details += `<br/>Updated: ${date.toLocaleString()}`;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateSampleMarkerVisibility(marker));

  // Store sample data on marker for event handlers
  marker.sample = s;

  // Add event handlers to show trace lines when clicking/hovering on sample
  marker.on('popupopen', e => {
    // Find the coverage object for this sample (sample ID is already 6-char geohash)
    const coverage = hashToCoverage?.get(s.id);
    if (coverage) {
      updateAllEdgeVisibility(coverage);
    }
  });
  marker.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    marker.on('mouseover', e => {
      const coverage = hashToCoverage?.get(s.id);
      if (coverage) {
        updateAllEdgeVisibility(coverage);
      }
    });
    marker.on('mouseout', () => updateAllEdgeVisibility());
  }

  return marker;
}

function individualSampleMarker(sample) {
  const [lat, lon] = posFromHash(sample.name);
  // Individual sample: heard = has path, lost = no path
  const heard = sample.metadata.path && sample.metadata.path.length > 0;
  const color = heard ? successRateToColor(1.0) : successRateToColor(0.0); // Green if heard, red if lost
  const style = {
    radius: 4, // Smaller for individual samples
    weight: 1,
    color: color,
    fillColor: color,
    fillOpacity: 0.8
  };
  const marker = L.circleMarker([lat, lon], style);
  const timeValue = sample.metadata.time;
  const date = timeValue ? new Date(typeof timeValue === 'string' ? parseInt(timeValue, 10) : timeValue) : null;
  const repeaters = sample.metadata.path || [];
  let details = `
    <strong>${sample.name}</strong><br/>
    ${lat.toFixed(4)}, ${lon.toFixed(4)}<br/>
    Status: ${heard ? '<span style="color: green;">Heard</span>' : '<span style="color: red;">Lost</span>'}<br/>`;
  if (repeaters.length > 0) {
    details += `<br/>Repeaters: ${repeaters.join(', ')}`;
  } else {
    details += '<br/>No repeaters heard';
  }
  if (sample.metadata.snr !== null && sample.metadata.snr !== undefined) {
    details += `<br/>SNR: ${sample.metadata.snr} dB`;
  }
  if (sample.metadata.rssi !== null && sample.metadata.rssi !== undefined) {
    details += `<br/>RSSI: ${sample.metadata.rssi} dBm`;
  }
  if (date && !isNaN(date.getTime())) {
    details += `<br/>Time: ${date.toLocaleString()}`;
  }
  marker.bindPopup(details, { maxWidth: 320 });

  // Store sample data on marker for event handlers
  marker.sample = sample;

  // Add event handlers to show trace lines when clicking/hovering on sample
  marker.on('popupopen', e => {
    // Find the coverage object for this sample (take first 6 chars of geohash)
    const coverageKey = sample.name.substring(0, 6);
    const coverage = hashToCoverage?.get(coverageKey);
    if (coverage) {
      updateAllEdgeVisibility(coverage);
    }
  });
  marker.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    marker.on('mouseover', e => {
      const coverageKey = sample.name.substring(0, 6);
      const coverage = hashToCoverage?.get(coverageKey);
      if (coverage) {
        updateAllEdgeVisibility(coverage);
      }
    });
    marker.on('mouseout', () => updateAllEdgeVisibility());
  }

  return marker;
}

function repeaterMarker(r) {
  // Ensure repeater ID is normalized to lowercase for consistent matching
  if (r.id) {
    r.id = r.id.toLowerCase();
  }
  const time = fromTruncatedTime(r.time);
  const stale = ageInDays(time) > 2;
  const dead = ageInDays(time) > 8;
  const ageClass = (dead ? "dead" : (stale ? "stale" : ""));

  // Display only first 2 chars in the circle (for backward compatibility)
  const displayId = r.id.substring(0, 2).toUpperCase();

  const icon = L.divIcon({
    className: '', // Don't use default Leaflet style.
    html: `<div class="repeater-dot ${ageClass}"><span>${displayId}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const details = [
    `<strong>${escapeHtml(r.name)} [${r.id}]</strong>`,
    `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · <em>${(r.elev).toFixed(0)}m</em>`,
    `${new Date(time).toLocaleString()}`
  ].join('<br/>');
  const marker = L.marker([r.lat, r.lon], { icon: icon });

  marker.repeater = r;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateRepeaterMarkerVisibility(marker));
  marker.on('popupopen', e => updateAllEdgeVisibility(e.target.repeater));
  marker.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    marker.on('mouseover', e => updateAllEdgeVisibility(e.target.repeater));
    marker.on('mouseout', () => updateAllEdgeVisibility());
  }

  r.marker = marker;
  return marker;
}

function getBestRepeater(fromPos, repeaterList) {
  if (repeaterList.length === 1) {
    return repeaterList[0];
  }

  let minRepeater = null;
  let minDist = 30000; // Bigger than any valid dist.

  repeaterList.forEach(r => {
    const to = [r.lat, r.lon];
    const elev = r.elev ?? 0; // Allow height to impact distance.
    const dist = haversineMiles(fromPos, to) - (0.5 * Math.sqrt(elev));
    if (dist < minDist) {
      minDist = dist;
      minRepeater = r;
    }
  });

  return minRepeater;
}

function shouldShowRepeater(r) {
  // Prioritize searching
  if (repeaterSearch !== '') {
    return r.id.toLowerCase().startsWith(repeaterSearch);
  } else if (repeaterRenderMode === "hit") {
    return r.hitBy.length > 0;
  } else if (repeaterRenderMode === 'none') {
    return false;
  }
  return true;
}

function updateSampleMarkerVisibility(s) {
  const el = s.getElement();
  if (showSamples) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }
}

function updateRepeaterMarkerVisibility(m, forceVisible = false, highlight = false) {
  const el = m.getElement();
  if (forceVisible || shouldShowRepeater(m.repeater)) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }

  if (highlight) {
    el.querySelector(".repeater-dot").classList.add("highlighted");
  } else {
    el.querySelector(".repeater-dot").classList.remove("highlighted");
  }
}

function updateAllRepeaterMarkers() {
  repeaterLayer.eachLayer(m => updateRepeaterMarkerVisibility(m));
}

function updateCoverageMarkerHighlight(m, highlight = false) {
  const el = m.getElement();
  if (highlight) {
    el.classList.add("highlighted-path");
  } else {
    el.classList.remove("highlighted-path");
  }
}

function updateAllCoverageMarkers() {
  coverageLayer.eachLayer(m => updateCoverageMarkerHighlight(m));
}

function updateAllEdgeVisibility(end) {
  const markersToOverride = [];
  const coverageToHighlight = [];

  // Reset markers to default.
  updateAllRepeaterMarkers();
  updateAllCoverageMarkers();

  edgeLayer.eachLayer(e => {
    let shouldShow = false;
    if (end !== undefined) {
      // e.ends is [repeater, coverage]
      // Check if end matches either the repeater or coverage
      // Use ID comparison instead of object reference to handle multiple repeaters with same ID

      // Check if it's a repeater (has id, lat, and lon as separate properties)
      // Repeaters have lat/lon as separate properties, coverage only has pos array
      if (end.id !== undefined && end.lat !== undefined && end.lon !== undefined) {
        // end is a repeater - compare by pubkey first, then fall back to ID (case-insensitive)
        const edgeRepeater = e.ends[0];
        const edgeKey = (edgeRepeater.pubkey || edgeRepeater.id || '').toLowerCase();
        const endKey = (end.pubkey || end.id || '').toLowerCase();
        shouldShow = edgeKey === endKey && edgeKey !== '';
      } else if (end.id !== undefined && Array.isArray(end.pos) && end.lat === undefined) {
        // end is a coverage - compare by geohash ID
        // Also check object reference as fallback
        shouldShow = e.ends[1].id === end.id || e.ends[1] === end;
      } else {
        // Fallback to object reference comparison
        shouldShow = e.ends.includes(end);
      }
    }

    if (shouldShow) {
      if (e.ends[0].marker) {
        markersToOverride.push(e.ends[0].marker);
      }
      if (e.ends[1].marker) {
        coverageToHighlight.push(e.ends[1].marker);
      }
      e.setStyle({ opacity: 0.6 });
    } else {
      e.setStyle({ opacity: 0 });
    }
  });

  // Force connected repeaters to be shown.
  markersToOverride.forEach(m => {
    if (m) updateRepeaterMarkerVisibility(m, true, true);
  });

  // Highlight connected coverage markers.
  coverageToHighlight.forEach(m => {
    if (m) updateCoverageMarkerHighlight(m, true);
  });
}

function renderNodes(nodes) {
  coverageLayer.clearLayers();
  edgeLayer.clearLayers();
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();

  // Add coverage boxes.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverageLayer.addLayer(coverageMarker(coverage));
  });

  // Add samples (aggregated if showSamples is false, individual if true)
  if (showSamples && individualSamples) {
    // Show individual samples
    individualSamples.keys.forEach(s => {
      sampleLayer.addLayer(individualSampleMarker(s));
    });
  } else {
    // Show aggregated samples
    nodes.samples.forEach(s => {
      sampleLayer.addLayer(sampleMarker(s));
    });
  }

  // Add repeaters.
  const repeatersToAdd = [...idToRepeaters.values()].flat();
  repeatersToAdd.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
  });

  // Add edges.
  // Use pubkey (or id) as key to ensure edges are unique per repeater pubkey
  const edgeKeys = new Set();
  edgeList.forEach(e => {
    const edgeKey = e.key || (e.repeater.pubkey || e.repeater.id);

    // Skip duplicate edges (same repeater pubkey to same coverage)
    const uniqueKey = `${edgeKey}-${e.coverage.id}`;
    if (edgeKeys.has(uniqueKey)) {
      return;
    }
    edgeKeys.add(uniqueKey);

    const style = {
      weight: 2,
      opacity: 0,
      dashArray: '2,4',
      interactive: false,
    };
    const line = L.polyline([e.repeater.pos, e.coverage.pos], style);
    line.ends = [e.repeater, e.coverage];
    line.addTo(edgeLayer);
  });
}

function buildIndexes(nodes) {
  hashToCoverage = new Map();
  idToRepeaters = new Map();
  idToRepeatersById = new Map();
  edgeList = [];

  // Index coverage items.
  nodes.coverage.forEach(c => {
    const { latitude: lat, longitude: lon } = geo.decode(c.id);
    c.pos = [lat, lon];
    if (c.rptr === undefined) c.rptr = [];
    // Map backend time fields to frontend time field
    // Backend sends ut (updated time), lht (last heard time), lot (last observed time)
    // Frontend expects time field
    if (!c.time && c.ut) {
      c.time = c.ut;
    } else if (!c.time && c.lot) {
      c.time = c.lot;
    } else if (!c.time && c.lht) {
      c.time = c.lht;
    }
    // Map backend rcv field (if present) or use heard
    if (c.rcv === undefined && c.heard !== undefined) {
      c.rcv = c.heard;
    }
    hashToCoverage.set(c.id, c);
  });

  // Add aggregated samples to coverage items.
  // Samples are now already aggregated by geohash prefix on the server
  nodes.samples.forEach(s => {
    const key = s.id; // Already a 6-char geohash prefix from server
    let coverage = hashToCoverage.get(key);
    const sampleHeard = s.heard || 0;
    const sampleLost = s.lost || 0;

    if (!coverage) {
      const { latitude: lat, longitude: lon } = geo.decode(key);
      coverage = {
        id: key,
        pos: [lat, lon],
        rcv: sampleHeard,
        lost: sampleLost,
        time: s.time || 0,
        rptr: (s.path || s.rptr) ? [...(s.path || s.rptr)] : [],
      };
      hashToCoverage.set(key, coverage);
    } else {
      // Merge sample data into existing coverage - samples should override coverage data
      // since samples are the source of truth
      coverage.rcv = sampleHeard;
      coverage.lost = sampleLost;
      if (s.time > (coverage.time || 0)) {
        coverage.time = s.time;
      }
      // Merge repeaters (avoid duplicates)
      const samplePath = s.path || s.rptr;
      if (samplePath) {
        samplePath.forEach(r => {
          const rLower = r.toLowerCase();
          if (!coverage.rptr.includes(rLower)) {
            coverage.rptr.push(rLower);
          }
        });
      }
    }
  });

  // Index repeaters.
  idToRepeatersById = new Map(); // Clear and rebuild
  nodes.repeaters.forEach(r => {
    r.hitBy = [];
    r.pos = [r.lat, r.lon];
    // Normalize repeater ID to lowercase for consistent lookup
    // (coverage.rptr stores IDs as lowercase)
    const normalizedId = r.id.toLowerCase();
    r.id = normalizedId; // Normalize the ID in the repeater object itself

    // Normalize pubkey if available
    r.pubkey = r.pubkey ? r.pubkey.toLowerCase() : null;

    // Use full public key as primary key if available, otherwise fall back to ID
    // This ensures edges are unique per pubkey
    const key = r.pubkey || normalizedId;
    pushMap(idToRepeaters, key, r);

    // Also index by 2-char ID for matching coverage.rptr (which only has IDs)
    pushMap(idToRepeatersById, normalizedId, r);
  });

  // Build connections.
  // coverage.rptr contains 2-char IDs, but we want to use full pubkeys for edges
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverage.rptr.forEach(rId => {
      // Look up by 2-char ID first (coverage.rptr only has IDs)
      const candidateRepeaters = idToRepeatersById.get(rId);
      if (candidateRepeaters === undefined)
        return;

      const bestRepeater = getBestRepeater(coverage.pos, candidateRepeaters);
      bestRepeater.hitBy.push(coverage);

      // Use pubkey (or id) as the edge key for uniqueness
      const edgeKey = bestRepeater.pubkey || bestRepeater.id;
      edgeList.push({ repeater: bestRepeater, coverage: coverage, key: edgeKey });
    });
  });
}

// Update repeaters list content
function updateRepeatersList(contentDiv) {
  if (!nodes || !idToRepeaters) {
    contentDiv.innerHTML = '<div style="padding: 20px; color: #e2e8f0; text-align: center;">No repeater data available.<br/>Please refresh the map first.</div>';
    return;
  }

  // Count geohashes per repeater
  const repeaterGeohashCount = new Map();

  let coverageWithRepeaters = 0;
  hashToCoverage.forEach((coverage) => {
    if (coverage.rptr && coverage.rptr.length > 0) {
      coverageWithRepeaters++;
      coverage.rptr.forEach(repeaterId => {
        const idLower = repeaterId.toLowerCase();
        repeaterGeohashCount.set(idLower, (repeaterGeohashCount.get(idLower) || 0) + 1);
      });
    }
  });

  // Get all repeaters with their geohash counts
  const repeaterStats = [];
  idToRepeaters.forEach((repeaters, id) => {
    const count = repeaterGeohashCount.get(id.toLowerCase()) || 0;
    if (count > 0) {
      repeaterStats.push({
        id: id,
        name: repeaters[0]?.name || id,
        geohashCount: count
      });
    }
  });

  // Sort by geohash count (descending)
  repeaterStats.sort((a, b) => b.geohashCount - a.geohashCount);

  if (repeaterStats.length === 0) {
    const totalRepeaters = idToRepeaters.size;
    const totalCoverage = hashToCoverage.size;
    contentDiv.innerHTML = `<div style="padding: 20px; color: #e2e8f0; text-align: center;">
      No repeaters with coverage data found.<br/><br/>
      <div style="font-size: 11px; color: #9ca3af; margin-top: 8px;">
        Total repeaters: ${totalRepeaters}<br/>
        Total coverage areas: ${totalCoverage}<br/>
        Coverage with repeaters: ${coverageWithRepeaters}
      </div>
      <div style="font-size: 11px; color: #9ca3af; margin-top: 12px;">
        Tip: Add samples with repeater paths to populate this list.
      </div>
    </div>`;
    return;
  }

  // Create simple concise list
  let html = '<div style="padding: 8px;">';

  repeaterStats.forEach((repeater) => {
    const prefix = repeater.id.substring(0, 2).toUpperCase();
    html += `<div style="padding: 8px 12px; color: #e2e8f0; border-bottom: 1px solid #4a5568; font-size: 13px; display: flex; justify-content: space-between; align-items: center;">
      <div style="display: flex; gap: 12px; align-items: center;">
        <span style="font-family: 'Courier New', monospace; font-weight: 600; color: #60a5fa; min-width: 24px;">${escapeHtml(prefix)}</span>
        <span>${escapeHtml(repeater.name)}</span>
      </div>
      <span style="color: #34d399; font-weight: 600; font-size: 13px;">${repeater.geohashCount}</span>
    </div>`;
  });

  html += '</div>';
  contentDiv.innerHTML = html;
}

// Update drivers list content
function updateDriversList(contentDiv) {
  if (!nodes || !nodes.drivers) {
    contentDiv.innerHTML = '<div style="padding: 20px; color: #e2e8f0; text-align: center;">No driver data available.<br/>Please refresh the map first.</div>';
    return;
  }

  const drivers = nodes.drivers || [];

  if (drivers.length === 0) {
    contentDiv.innerHTML = `<div style="padding: 20px; color: #e2e8f0; text-align: center;">
      No drivers found.<br/><br/>
      <div style="font-size: 11px; color: #9ca3af; margin-top: 8px;">
        Drivers are tracked from wardrive app users.
      </div>
    </div>`;
    return;
  }

  // Create simple concise list
  let html = '<div style="padding: 8px;">';

  drivers.forEach((driver) => {
    const heardPercent = driver.heardPercent ?? (driver.count > 0 ? ((driver.heard || 0) / driver.count * 100) : 0);
    const heard = driver.heard || 0;
    const lost = driver.lost || 0;
    const total = driver.count;
    const percentText = `${Math.round(heardPercent * 10) / 10}%`;

    // Color based on success rate (green for high, red for low)
    const color = heardPercent >= 75 ? '#34d399' : heardPercent >= 50 ? '#fbbf24' : '#f87171';

    html += `<div style="padding: 8px 12px; color: #e2e8f0; border-bottom: 1px solid #4a5568; font-size: 13px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <div style="display: flex; gap: 12px; align-items: center;">
          <span style="font-weight: 500;">${escapeHtml(driver.name)}</span>
        </div>
        <span style="color: #34d399; font-weight: 600; font-size: 13px;">${total}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #9ca3af;">
        <span>${heard} heard, ${lost} missed</span>
        <span style="color: ${color}; font-weight: 600;">${percentText}</span>
      </div>
    </div>`;
  });

  html += '</div>';
  contentDiv.innerHTML = html;
}

async function loadIndividualSamples() {
  try {
    const endpoint = "/get-samples";
    const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

    if (!resp.ok)
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    individualSamples = await resp.json();

    // Clear sample layer and render with individual samples
    sampleLayer.clearLayers();
    individualSamples.keys.forEach(s => {
      sampleLayer.addLayer(individualSampleMarker(s));
    });
  } catch (error) {
    console.error("Error loading individual samples:", error);
    alert("Failed to load individual samples: " + error.message);
  }
}

function clearIndividualSamples() {
  individualSamples = null;
  // Don't clear the layer here - renderNodes will handle it
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";

  // Build query string from driver filters
  const params = new URLSearchParams();
  if (driverFilters && Object.keys(driverFilters).length > 0) {
    Object.keys(driverFilters).forEach(key => {
      if (driverFilters[key] !== null && driverFilters[key] !== "") {
        params.append(key, driverFilters[key]);
      }
    });
  }

  const url = params.toString() ? `${endpoint}?${params.toString()}` : endpoint;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  buildIndexes(nodes);
  renderNodes(nodes);

  // Update drivers list if it's open
  const driversList = document.getElementById("drivers-list");
  const driversContent = document.getElementById("drivers-list-content");
  if (driversList && driversContent && driversList.style.display !== "none") {
    updateDriversList(driversContent);
  }
}
