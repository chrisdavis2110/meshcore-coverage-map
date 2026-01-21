import {
  ageInDays,
  centerPos,
  geo,
  haversineMiles,
  initialZoom,
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
let colorPalette = 'red-yellow-green'; // 'red-yellow-green', 'blue', 'patterns'
let queryMode = 'coverage'; // 'coverage', 'observed-pct', 'heard-pct', 'last-updated', 'past-day', 'repeater-count', 'sample-count'

// Data
let nodes = null; // Graph data from the last refresh
let idToRepeaters = null; // Index of pubkey (or id if no pubkey) -> [repeater]
let idToRepeatersById = null; // Index of 2-char id -> [repeater] for matching coverage.rptr
let hashToCoverage = null; // Index of geohash -> coverage
let edgeList = null; // List of connected repeater and coverage
let individualSamples = null; // Individual (non-aggregated) samples
// let driverFilters = {}; // Driver filter state

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
        Query:
        <select id="query-mode-select">
          <option value="coverage" selected="true">Coverage</option>
          <option value="observed-pct">Observed %</option>
          <option value="heard-pct">Heard %</option>
          <option value="last-updated">Last Updated</option>
          <option value="past-day">Past Day</option>
          <option value="repeater-count">Repeater Count</option>
          <option value="sample-count">Sample Count</option>
        </select>
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Color Palette:
        <select id="color-palette-select">
          <option value="red-yellow-green" selected="true">Red/Yellow/Green</option>
          <option value="blue">Blue</option>
          <option value="patterns">Patterns</option>
          <option value="simple-green">Simple Green</option>
        </select>
      </label>
    </div>
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

  div.querySelector("#query-mode-select")
    .addEventListener("change", (e) => {
      queryMode = e.target.value;
      if (nodes) {
        renderNodes(nodes);
      }
    });

  div.querySelector("#color-palette-select")
    .addEventListener("change", (e) => {
      colorPalette = e.target.value;
      if (nodes) {
        renderNodes(nodes);
      }
    });

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
  `;

  const repeatersButton = div.querySelector("#repeaters-button");
  const repeatersList = div.querySelector("#repeaters-list");
  const repeatersContent = div.querySelector("#repeaters-list-content");
  // const driversButton = div.querySelector("#drivers-button");
  // const driversList = div.querySelector("#drivers-list");
  // const driversContent = div.querySelector("#drivers-list-content");

  repeatersButton.addEventListener("click", (e) => {
    e.stopPropagation();
    // driversList.style.display = "none"; // Close drivers list
    if (repeatersList.style.display === "none") {
      updateRepeatersList(repeatersContent);
      repeatersList.style.display = "block";
    } else {
      repeatersList.style.display = "none";
    }
  });

  // driversButton.addEventListener("click", (e) => {
  //   e.stopPropagation();
  //   repeatersList.style.display = "none"; // Close repeaters list
  //   if (driversList.style.display === "none") {
  //     updateDriversList(driversContent);
  //     driversList.style.display = "block";
  //   } else {
  //     driversList.style.display = "none";
  //   }
  // });

  // // Filter button handlers
  // const driversFilterBtn = div.querySelector("#drivers-filter-btn");
  // const driversFilterPanel = div.querySelector("#drivers-filter-panel");
  // const driversFilterApply = div.querySelector("#drivers-filter-apply");
  // const driversFilterClear = div.querySelector("#drivers-filter-clear");

  // if (driversFilterBtn) {
  //   driversFilterBtn.addEventListener("click", (e) => {
  //     e.stopPropagation();
  //     const isVisible = driversFilterPanel.style.display !== "none";
  //     driversFilterPanel.style.display = isVisible ? "none" : "block";
  //   });
  // }

  // if (driversFilterApply) {
  //   driversFilterApply.addEventListener("click", async (e) => {
  //     e.stopPropagation();
  //     // Collect filter values
  //     driverFilters = {
  //       minCount: document.getElementById("filter-min-count")?.value || null,
  //       maxCount: document.getElementById("filter-max-count")?.value || null,
  //       minHeard: document.getElementById("filter-min-heard")?.value || null,
  //       maxHeard: document.getElementById("filter-max-heard")?.value || null,
  //       minLost: document.getElementById("filter-min-lost")?.value || null,
  //       maxLost: document.getElementById("filter-max-lost")?.value || null,
  //       minPercent: document.getElementById("filter-min-percent")?.value || null,
  //       maxPercent: document.getElementById("filter-max-percent")?.value || null,
  //       sortBy: document.getElementById("filter-sort-by")?.value || "count",
  //       sortOrder: document.getElementById("filter-sort-order")?.value || "desc"
  //     };

  //     // Remove null/empty values
  //     Object.keys(driverFilters).forEach(key => {
  //       if (driverFilters[key] === null || driverFilters[key] === "") {
  //         delete driverFilters[key];
  //       }
  //     });

  //     // Refresh data with filters
  //     await refreshCoverage();
  //     updateDriversList(driversContent);
  //   });
  // }

  // if (driversFilterClear) {
  //   driversFilterClear.addEventListener("click", async (e) => {
  //     e.stopPropagation();
  //     // Clear all filter inputs
  //     const inputs = ["filter-min-count", "filter-max-count", "filter-min-heard", "filter-max-heard",
  //                    "filter-min-lost", "filter-max-lost", "filter-min-percent", "filter-max-percent"];
  //     inputs.forEach(id => {
  //       const el = document.getElementById(id);
  //       if (el) el.value = "";
  //     });
  //     const sortBy = document.getElementById("filter-sort-by");
  //     const sortOrder = document.getElementById("filter-sort-order");
  //     if (sortBy) sortBy.value = "count";
  //     if (sortOrder) sortOrder.value = "desc";

  //     // Clear filter state and refresh
  //     driverFilters = {};
  //     await refreshCoverage();
  //     updateDriversList(driversContent);
  //   });
  // }

  // Close when clicking outside (use the map parameter 'm' passed to onAdd)
  const closeHandler = () => {
    repeatersList.style.display = "none";
    // driversList.style.display = "none";
  };
  m.on("click", closeHandler);

  // Prevent clicks inside the lists from closing them
  repeatersList.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  // driversList.addEventListener("click", (e) => {
  //   e.stopPropagation();
  // });

  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};
// Initialization function - loads config and sets up map
async function initMap() {
  // Load config from server
  await loadConfig();

  // Initialize map with configured center position and initial zoom
  map = L.map('map', { worldCopyJump: true }).setView(centerPos, initialZoom);

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

  // Initialize SVG patterns for pattern palette
  initSVGPatterns();

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

// Initialize SVG patterns for pattern palette
function initSVGPatterns() {
  // Wait for map to be ready, then add patterns to the SVG container
  map.whenReady(() => {
    // Use a small delay to ensure Leaflet has created the SVG
    setTimeout(() => {
      const mapContainer = map.getContainer();
      let svg = mapContainer.querySelector('svg.leaflet-zoom-animated');

      if (!svg) {
        // Try again after a longer delay
        setTimeout(initSVGPatterns, 200);
        return;
      }

      let svgDefs = svg.querySelector('defs');

      // Create defs if it doesn't exist
      if (!svgDefs) {
        svgDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.insertBefore(svgDefs, svg.firstChild);
      }

      // Check if patterns already exist
      if (svgDefs.querySelector('#pattern-sparse-lines')) {
        return; // Patterns already initialized
      }

    // Sparse horizontal lines pattern (0%) - screen-door effect
    const sparseLines = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    sparseLines.setAttribute('id', 'pattern-sparse-lines');
    sparseLines.setAttribute('patternUnits', 'userSpaceOnUse');
    sparseLines.setAttribute('width', '20');
    sparseLines.setAttribute('height', '20');
    const sparseLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sparseLine.setAttribute('x1', '0');
    sparseLine.setAttribute('y1', '10');
    sparseLine.setAttribute('x2', '20');
    sparseLine.setAttribute('y2', '10');
    sparseLine.setAttribute('stroke', '#000000');
    sparseLine.setAttribute('stroke-width', '1');
    sparseLines.appendChild(sparseLine);
    svgDefs.appendChild(sparseLines);

    // Medium horizontal lines pattern (>0%)
    const mediumLines = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    mediumLines.setAttribute('id', 'pattern-medium-lines');
    mediumLines.setAttribute('patternUnits', 'userSpaceOnUse');
    mediumLines.setAttribute('width', '12');
    mediumLines.setAttribute('height', '12');
    const mediumLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    mediumLine1.setAttribute('x1', '0');
    mediumLine1.setAttribute('y1', '4');
    mediumLine1.setAttribute('x2', '12');
    mediumLine1.setAttribute('y2', '4');
    mediumLine1.setAttribute('stroke', '#000000');
    mediumLine1.setAttribute('stroke-width', '1');
    const mediumLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    mediumLine2.setAttribute('x1', '0');
    mediumLine2.setAttribute('y1', '8');
    mediumLine2.setAttribute('x2', '12');
    mediumLine2.setAttribute('y2', '8');
    mediumLine2.setAttribute('stroke', '#000000');
    mediumLine2.setAttribute('stroke-width', '1');
    mediumLines.appendChild(mediumLine1);
    mediumLines.appendChild(mediumLine2);
    svgDefs.appendChild(mediumLines);

    // Dense horizontal lines pattern (>25%)
    const denseLines = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    denseLines.setAttribute('id', 'pattern-dense-lines');
    denseLines.setAttribute('patternUnits', 'userSpaceOnUse');
    denseLines.setAttribute('width', '8');
    denseLines.setAttribute('height', '8');
    const denseLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    denseLine1.setAttribute('x1', '0');
    denseLine1.setAttribute('y1', '2');
    denseLine1.setAttribute('x2', '8');
    denseLine1.setAttribute('y2', '2');
    denseLine1.setAttribute('stroke', '#000000');
    denseLine1.setAttribute('stroke-width', '1');
    const denseLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    denseLine2.setAttribute('x1', '0');
    denseLine2.setAttribute('y1', '6');
    denseLine2.setAttribute('x2', '8');
    denseLine2.setAttribute('y2', '6');
    denseLine2.setAttribute('stroke', '#000000');
    denseLine2.setAttribute('stroke-width', '1');
    denseLines.appendChild(denseLine1);
    denseLines.appendChild(denseLine2);
    svgDefs.appendChild(denseLines);

    // Very dense horizontal lines pattern (>40%)
    const veryDenseLines = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    veryDenseLines.setAttribute('id', 'pattern-very-dense-lines');
    veryDenseLines.setAttribute('patternUnits', 'userSpaceOnUse');
    veryDenseLines.setAttribute('width', '4');
    veryDenseLines.setAttribute('height', '4');
    const veryDenseLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    veryDenseLine1.setAttribute('x1', '0');
    veryDenseLine1.setAttribute('y1', '1');
    veryDenseLine1.setAttribute('x2', '4');
    veryDenseLine1.setAttribute('y2', '1');
    veryDenseLine1.setAttribute('stroke', '#000000');
    veryDenseLine1.setAttribute('stroke-width', '1');
    const veryDenseLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    veryDenseLine2.setAttribute('x1', '0');
    veryDenseLine2.setAttribute('y1', '3');
    veryDenseLine2.setAttribute('x2', '4');
    veryDenseLine2.setAttribute('y2', '3');
    veryDenseLine2.setAttribute('stroke', '#000000');
    veryDenseLine2.setAttribute('stroke-width', '1');
    veryDenseLines.appendChild(veryDenseLine1);
    veryDenseLines.appendChild(veryDenseLine2);
    svgDefs.appendChild(veryDenseLines);

    // Solid pattern (>70%) - very dense lines that appear almost solid
    const solid = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    solid.setAttribute('id', 'pattern-solid');
    solid.setAttribute('patternUnits', 'userSpaceOnUse');
    solid.setAttribute('width', '2');
    solid.setAttribute('height', '2');
    const solidLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    solidLine.setAttribute('x1', '0');
    solidLine.setAttribute('y1', '1');
    solidLine.setAttribute('x2', '2');
    solidLine.setAttribute('y2', '1');
    solidLine.setAttribute('stroke', '#000000');
    solidLine.setAttribute('stroke-width', '1');
    solid.appendChild(solidLine);
    svgDefs.appendChild(solid);
    }, 100); // Delay to ensure SVG is ready
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Convert rate to hex color
function toHex(n) {
  const hex = n.toString(16);
  return hex.length === 1 ? '0' + hex : hex;
}

function rgbToHex(r, g, b) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Palette 1: Red/Orange/Yellow/Light-Green/Dark-Green
// 0=red, >0=red, >25%=orange, >40%=yellow, >70%=light green, >70%=dark green
function paletteRedYellowGreen(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (clampedRate === 0) {
    return '#FF0000'; // Red
  } else if (clampedRate <= 0.25) {
    return '#FF0000'; // Red
  } else if (clampedRate <= 0.40) {
    return '#FFA500'; // Orange
  } else if (clampedRate <= 0.70) {
    return '#FFFF00'; // Yellow
  } else if (clampedRate <= 0.85) {
    return '#90EE90'; // Light green
  } else {
    return '#006400'; // Dark green
  }
}

// Palette 2: Blue (wider range from very light to very dark)
// 0=very light blue, >0=light blue, >25%=medium blue, >40%=blue, >70%=dark blue, >85%=very dark blue
function paletteBlue(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (clampedRate === 0) {
    return '#E6F3FF'; // Very light blue
  } else if (clampedRate <= 0.25) {
    return '#B3D9FF'; // Light blue
  } else if (clampedRate <= 0.40) {
    return '#87CEEB'; // Medium blue (sky blue)
  } else if (clampedRate <= 0.70) {
    return '#4169E1'; // Royal blue
  } else if (clampedRate <= 0.85) {
    return '#0000CD'; // Medium dark blue
  } else {
    return '#000033'; // Very dark blue
  }
}

// Palette 3: Patterns (screen-door effect with sparse to dense lines for colorblind accessibility)
// Returns an object with fillColor, fillPattern, and patternId
function palettePatterns(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  let patternId;
  if (clampedRate === 0) {
    patternId = 'pattern-sparse-lines';
  } else if (clampedRate <= 0.25) {
    patternId = 'pattern-medium-lines';
  } else if (clampedRate <= 0.40) {
    patternId = 'pattern-dense-lines';
  } else if (clampedRate <= 0.70) {
    patternId = 'pattern-very-dense-lines';
  } else {
    patternId = 'pattern-solid';
  }

  return {
    fillColor: '#E0E0E0', // Light grey base (will be overlaid with black patterns)
    fillPattern: patternId,
    patternUrl: `url(#${patternId})`
  };
}

// Palette 4: Simple Green (3 options)
// <25% = empty gray box (with gray border), <50% = light green, <100% = dark green
function paletteSimpleGreen(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (clampedRate < 0.25) {
    return {
      fillColor: '#F5F5F5', // Very light gray (appears empty)
      borderColor: '#808080', // Gray border
      fillOpacity: 0, // Transparent fill
      hasBorder: true
    };
  } else if (clampedRate < 0.50) {
    return {
      fillColor: '#90EE90', // Light green
      borderColor: '#90EE90',
      fillOpacity: 1,
      hasBorder: false
    };
  } else {
    return {
      fillColor: '#006400', // Dark green
      borderColor: '#006400',
      fillOpacity: 1,
      hasBorder: false
    };
  }
}

// Main function to get color/style based on selected palette
function successRateToColor(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (colorPalette === 'red-yellow-green') {
    return paletteRedYellowGreen(clampedRate);
  } else if (colorPalette === 'blue') {
    return paletteBlue(clampedRate);
  } else if (colorPalette === 'patterns') {
    const pattern = palettePatterns(clampedRate);
    return pattern.fillColor; // For markers that don't support patterns, return base color
  } else if (colorPalette === 'simple-green') {
    const simple = paletteSimpleGreen(clampedRate);
    // For empty boxes (hasBorder: true), return gray for circle markers
    return simple.hasBorder ? '#808080' : simple.fillColor;
  }

  // Fallback to red-yellow-green
  return paletteRedYellowGreen(clampedRate);
}

// Get value for current query mode (0-1 for color mapping)
function getQueryValue(coverage) {
  function recencyScore(ageDays) {
    // Piecewise mapping:
    // <=1 day: 1.0
    // 2 days: 0.75
    // 3 days: 0.50
    // 5 days: 0.25
    // >=7 days: 0.0
    const points = [
      { d: 0, v: 1.0 },
      { d: 1, v: 1.0 },
      { d: 2, v: 0.75 },
      { d: 3, v: 0.50 },
      { d: 5, v: 0.25 },
      { d: 7, v: 0.0 },
      { d: 30, v: 0.0 },
    ];

    // Clamp negative ages to 0
    const clampedAge = Math.max(0, ageDays);

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if (clampedAge <= curr.d) {
        const t = (clampedAge - prev.d) / (curr.d - prev.d);
        return prev.v + (curr.v - prev.v) * t;
      }
    }
    return 0.0;
  }

  switch (queryMode) {
    case 'coverage': {
      const totalSamples = coverage.rcv + coverage.lost;
      return totalSamples > 0 ? coverage.rcv / totalSamples : 0;
    }
    case 'observed-pct': {
      // Observed %: obs / total samples
      const totalSamples = coverage.rcv + coverage.lost;
      const obs = coverage.obs ?? 0;
      return totalSamples > 0 ? obs / totalSamples : 0;
    }
    case 'heard-pct': {
      // Heard %: rcv / (rcv + lost)
      const totalSamples = coverage.rcv + coverage.lost;
      return totalSamples > 0 ? coverage.rcv / totalSamples : 0;
    }
    case 'last-updated': {
      // Color by recency with fixed breakpoints:
      // <=1d:1.0, 2d:0.75, 3d:0.50, 5d:0.25, >=7d:0.0
      const truncatedTime = coverage.time || coverage.ut || coverage.lot || coverage.lht || 0;
      if (truncatedTime === 0) return 0.0; // No time data = old
      const timeMs = fromTruncatedTime(truncatedTime);
      const nowMs = Date.now();
      const ageMs = nowMs - timeMs;
      const ageDays = ageMs / (1000 * 86400);
      return recencyScore(ageDays);
    }
    case 'past-day': {
      // Only show if within past 24h, otherwise return 0 (will be filtered)
      const truncatedTime = coverage.time || coverage.ut || coverage.lot || coverage.lht || 0;
      if (truncatedTime === 0) return 0; // No time data = filter out
      const timeMs = fromTruncatedTime(truncatedTime);
      const nowMs = Date.now();
      const ageMs = nowMs - timeMs;
      const ageDays = ageMs / (1000 * 86400);
      if (ageDays > 1) return 0; // Filter out old data
      // Within past day, still use recency scaling so sub-day ages stay at 1.0
      return recencyScore(ageDays);
    }
    case 'repeater-count': {
      // Color by repeater count: 0=0.0, 1=0.5, 2=0.75, >2=1.0
      const count = (coverage.rptr && coverage.rptr.length) || 0;
      if (count === 0) return 0.0;
      if (count === 1) return 0.5;
      if (count === 2) return 0.75;
      return 1.0; // >2
    }
    case 'sample-count': {
      // Color by sample count, normalized to min/max in current data
      const count = coverage.rcv + coverage.lost;
      if (count === 0) return 0.0;
      // Use normalized value (will be calculated in renderNodes)
      const range = globalSampleMax - globalSampleMin;
      return range > 0 ? (count - globalSampleMin) / range : 1.0;
    }
    default:
      return 0;
  }
}

// Get global min/max for sample count normalization
let globalSampleMin = 0;
let globalSampleMax = 1;

function updateGlobalSampleStats() {
  if (!hashToCoverage) {
    globalSampleMin = 0;
    globalSampleMax = 1;
    return;
  }
  let min = Infinity;
  let max = 0;
  hashToCoverage.forEach((coverage) => {
    const count = coverage.rcv + coverage.lost;
    if (count > 0) {
      min = Math.min(min, count);
      max = Math.max(max, count);
    }
  });
  globalSampleMin = min === Infinity ? 0 : min;
  globalSampleMax = max === 0 ? 1 : max;
}

// Get style object for patterns (used by rectangles)
function successRateToStyle(rate) {
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (colorPalette === 'patterns') {
    const pattern = palettePatterns(clampedRate);
    return {
      fillColor: pattern.fillColor,
      fillPattern: pattern.fillPattern,
      patternUrl: pattern.patternUrl
    };
  } else if (colorPalette === 'simple-green') {
    const simple = paletteSimpleGreen(clampedRate);
    return {
      fillColor: simple.fillColor,
      borderColor: simple.borderColor,
      fillOpacity: simple.fillOpacity,
      hasBorder: simple.hasBorder
    };
  }

  // For color palettes, return just the color
  return {
    fillColor: successRateToColor(clampedRate)
  };
}

function coverageMarker(coverage) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(coverage.id);

  // Get value for current query mode
  let queryValue = getQueryValue(coverage);

  // For past-day, filter out if value is 0
  if (queryMode === 'past-day' && queryValue === 0) {
    return null; // Don't render this marker
  }

  // Get style based on palette
  const styleInfo = successRateToStyle(queryValue);
  const color = successRateToColor(queryValue);
  const date = new Date(fromTruncatedTime(coverage.time || 0));

  const totalSamples = coverage.rcv + coverage.lost;
  const heardRatio = totalSamples > 0 ? coverage.rcv / totalSamples : 0;

  // Ensure tiles with only lost samples are visible
  // Base opacity on total samples, but ensure minimum visibility for lost-only tiles
  const baseOpacity = 0.75 * sigmoid(totalSamples, 1.2, 2);
  // For query modes, use queryValue for opacity; for others, use heardRatio
  const opacityValue = (queryMode === 'past-day' || queryMode === 'last-updated')
    ? queryValue
    : (heardRatio > 0 ? baseOpacity * heardRatio : Math.max(baseOpacity, 0.4));

  const style = {
    color: styleInfo.borderColor || color,
    weight: styleInfo.hasBorder ? 2 : 1, // Thicker border for empty boxes
    fillColor: styleInfo.fillColor || color,
    fillOpacity: styleInfo.fillOpacity !== undefined ? styleInfo.fillOpacity : Math.max(opacityValue, 0.2), // Use palette opacity or minimum 20% opacity
  };

  const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);

  // Apply pattern if using patterns palette
  if (colorPalette === 'patterns' && styleInfo.patternUrl) {
    rect.on('add', function() {
      // Use setTimeout to ensure the element is fully rendered
      setTimeout(() => {
        const path = rect.getElement();
        if (path) {
          path.setAttribute('fill', styleInfo.patternUrl);
          path.setAttribute('fill-opacity', style.fillOpacity || 0.6);
        }
      }, 10);
    });
  }
  let details = `
    <strong>${coverage.id}</strong><br/>
    Heard: ${coverage.rcv} Lost: ${coverage.lost} (${(100 * heardRatio).toFixed(0)}%)<br/>`;
  if (coverage.obs !== undefined) {
    details += `Observed: ${coverage.obs}<br/>`;
  }
  details += `Updated: ${date.toLocaleString()}`;
  if (coverage.rptr && coverage.rptr.length > 0) {
    details += `<br/>Repeaters: ${coverage.rptr.map(r => r.toUpperCase()).join(',')}`;
  }
  if (coverage.snr !== null && coverage.snr !== undefined) {
    details += `<br/>SNR: ${coverage.snr} dB`;
  }
  if (coverage.rssi !== null && coverage.rssi !== undefined) {
    details += `<br/>RSSI: ${coverage.rssi} dBm`;
  }

  rect.coverage = coverage;
  // Store region on marker for edge visibility filtering
  rect.region = coverage.region || null;
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
  // Store region on marker for edge visibility filtering
  marker.region = r.region || null;
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

/**
 * Find the repeater with the geohash closest to the coverage tile's geohash.
 * Uses longest common prefix as the primary metric, with distance as tiebreaker.
 */
function getBestRepeaterByGeohash(coverageGeohash, repeaterList) {
  if (repeaterList.length === 1) {
    return repeaterList[0];
  }

  let bestRepeater = null;
  let maxCommonPrefix = -1;
  let minDistance = Infinity;

  repeaterList.forEach(r => {
    // Get repeater's geohash (6-char to match coverage tile precision)
    const repeaterGeohash = r.geohash || geo.encode(r.lat, r.lon, 6);

    // Calculate longest common prefix length
    let commonPrefix = 0;
    const minLen = Math.min(coverageGeohash.length, repeaterGeohash.length);
    for (let i = 0; i < minLen; i++) {
      if (coverageGeohash[i] === repeaterGeohash[i]) {
        commonPrefix++;
      } else {
        break;
      }
    }

    // Calculate actual distance as tiebreaker
    // Decode coverage geohash to get lat/lon (geo.decode returns {latitude, longitude})
    const coveragePos = geo.decode(coverageGeohash);
    const distance = haversineMiles(
      [r.lat, r.lon],
      [coveragePos.latitude, coveragePos.longitude]
    );

    // Prefer longer common prefix, or if equal, prefer shorter distance
    if (commonPrefix > maxCommonPrefix ||
        (commonPrefix === maxCommonPrefix && distance < minDistance)) {
      maxCommonPrefix = commonPrefix;
      minDistance = distance;
      bestRepeater = r;
    }
  });

  return bestRepeater;
}

/**
 * Fallback function using distance (for backward compatibility or when geohash not available)
 */

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
      // Use object reference first (most reliable), then pubkey (unique), then ID+location

      // Get the region of the hovered element
      // end can be: repeater object, coverage object, or marker
      let endRegion = null;
      if (end.region !== undefined && end.region !== null) {
        // Direct region property (on repeater/coverage object or marker)
        endRegion = end.region;
      } else if (end.repeater && end.repeater.region) {
        // Marker with repeater property
        endRegion = end.repeater.region;
      } else if (end.coverage && end.coverage.region) {
        // Marker with coverage property
        endRegion = end.coverage.region;
      } else if (end.marker) {
        // Object with marker property
        endRegion = end.marker.region;
      }

      // Get the edge's repeater and coverage regions
      const edgeRepeater = e.ends[0];
      const edgeCoverage = e.ends[1];
      const edgeRepeaterRegion = edgeRepeater.marker?.region || edgeRepeater.region || null;
      const edgeCoverageRegion = edgeCoverage.marker?.region || edgeCoverage.region || null;

      // Check if it's a repeater (has id, lat, and lon as separate properties)
      // Repeaters have lat/lon as separate properties, coverage only has pos array
      if (end.id !== undefined && end.lat !== undefined && end.lon !== undefined) {
        // end is a repeater
        // First try object reference (most reliable - each repeater object is unique)
        if (edgeRepeater === end) {
          shouldShow = true;
        } else if (edgeRepeater.pubkey && end.pubkey) {
          // If both have pubkeys, compare by pubkey (should be unique)
          shouldShow = edgeRepeater.pubkey.toLowerCase() === end.pubkey.toLowerCase();
        } else {
          // Fallback: compare by ID AND location (to handle same ID in different regions)
          const idMatch = edgeRepeater.id && end.id &&
                         edgeRepeater.id.toLowerCase() === end.id.toLowerCase();
          const locationMatch = edgeRepeater.lat === end.lat && edgeRepeater.lon === end.lon;
          shouldShow = idMatch && locationMatch;
        }

        // If we have regions, only show edges where both repeater and coverage match the region
        if (shouldShow && endRegion !== null) {
          const regionMatch = (edgeRepeaterRegion === endRegion || edgeRepeaterRegion === null) &&
                             (edgeCoverageRegion === endRegion || edgeCoverageRegion === null);
          shouldShow = shouldShow && regionMatch;
        }
      } else if (end.id !== undefined && Array.isArray(end.pos) && end.lat === undefined) {
        // end is a coverage - compare by geohash ID
        // Also check object reference as fallback
        shouldShow = e.ends[1].id === end.id || e.ends[1] === end;

        // If we have regions, only show edges where both repeater and coverage match the region
        if (shouldShow && endRegion !== null) {
          const regionMatch = (edgeRepeaterRegion === endRegion || edgeRepeaterRegion === null) &&
                             (edgeCoverageRegion === endRegion || edgeCoverageRegion === null);
          shouldShow = shouldShow && regionMatch;
        }
      } else {
        // Fallback to object reference comparison
        shouldShow = e.ends.includes(end);

        // If we have regions, only show edges where both repeater and coverage match the region
        if (shouldShow && endRegion !== null) {
          const regionMatch = (edgeRepeaterRegion === endRegion || edgeRepeaterRegion === null) &&
                             (edgeCoverageRegion === endRegion || edgeCoverageRegion === null);
          shouldShow = shouldShow && regionMatch;
        }
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

  // Update global stats for sample-count normalization
  if (queryMode === 'sample-count') {
    updateGlobalSampleStats();
  }

  // Add coverage boxes.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    const marker = coverageMarker(coverage);
    if (marker) { // Past-day mode may return null
      coverageLayer.addLayer(marker);
    }
  });

  // Add samples (aggregated if showSamples is false, individual if true)
  if (showSamples && individualSamples) {
    // Show individual samples
    individualSamples.keys.forEach(s => {
      const [lat, lon] = posFromHash(s.name);
      const samplePos = [lat, lon];
      // Always filter by distance (use default if maxDistanceMiles is 0)
      // Default to 2500 miles if not configured (reasonable default for USA)
      const maxDistance = maxDistanceMiles > 0 ? maxDistanceMiles : 2500;
      const distance = haversineMiles(centerPos, samplePos);
      if (distance > maxDistance) {
        return; // Skip samples outside the mileage range
      }
      // Only show samples that have a corresponding coverage tile
      // Individual samples use 8-char geohash, coverage uses 6-char geohash
      const coverageKey = s.name.substring(0, 6);
      if (!hashToCoverage || !hashToCoverage.has(coverageKey)) {
        return; // Skip samples without a coverage tile
      }
      sampleLayer.addLayer(individualSampleMarker(s));
    });
  } else {
    // Show aggregated samples
    nodes.samples.forEach(s => {
      const [lat, lon] = posFromHash(s.id);
      const samplePos = [lat, lon];
      // Always filter by distance (use default if maxDistanceMiles is 0)
      // Default to 2500 miles if not configured (reasonable default for USA)
      const maxDistance = maxDistanceMiles > 0 ? maxDistanceMiles : 2500;
      const distance = haversineMiles(centerPos, samplePos);
      if (distance > maxDistance) {
        return; // Skip samples outside the mileage range
      }
      // Only show samples that have a corresponding coverage tile
      // Aggregated samples use 6-char geohash (same as coverage)
      if (!hashToCoverage || !hashToCoverage.has(s.id)) {
        return; // Skip samples without a coverage tile
      }
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
      weight: 3,
      opacity: 0,
      color: '#1e40af', // Darker blue
      dashArray: '2,4',
      interactive: false,
    };
    const line = L.polyline([e.repeater.pos, e.coverage.pos], style);
    line.ends = [e.repeater, e.coverage];
    // Store regions on the line for edge visibility filtering
    line.repeaterRegion = e.repeater.region || null;
    line.coverageRegion = e.coverage.region || null;
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
    // Ensure obs and hrd fields exist (from backend obs/rcv)
    if (c.obs === undefined) {
      c.obs = c.observed ?? 0;
    }
    if (c.hrd === undefined) {
      c.hrd = c.rcv ?? 0;
    }
    // snr and rssi are already on c from backend and will be preserved when set in map
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
        snr: (s.snr !== null && s.snr !== undefined) ? s.snr : undefined,
        rssi: (s.rssi !== null && s.rssi !== undefined) ? s.rssi : undefined,
        obs: (s.obs !== undefined) ? (s.obs ? 1 : 0) : 0, // Preserve obs from samples
      };
      hashToCoverage.set(key, coverage);
    } else {
      // Merge sample data into existing coverage - samples should override coverage data
      // since samples are the source of truth
      coverage.rcv = sampleHeard;
      coverage.lost = sampleLost;
      // Update obs if present in sample
      if (s.obs !== undefined) {
        coverage.obs = s.obs ? 1 : 0;
      }
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
      // Merge snr/rssi - use max value (same logic as backend)
      if (s.snr !== null && s.snr !== undefined) {
        coverage.snr = (coverage.snr === null || coverage.snr === undefined)
          ? s.snr
          : Math.max(coverage.snr, s.snr);
      }
      if (s.rssi !== null && s.rssi !== undefined) {
        coverage.rssi = (coverage.rssi === null || coverage.rssi === undefined)
          ? s.rssi
          : Math.max(coverage.rssi, s.rssi);
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

    // Compute repeater's geohash (6-char to match coverage tile precision)
    r.geohash = geo.encode(r.lat, r.lon, 6);

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
    // coverage.id is the 6-char geohash of the coverage tile
    const coverageGeohash = key; // This is already the 6-char geohash

    coverage.rptr.forEach(rId => {
      // Look up by 2-char ID first (coverage.rptr only has IDs)
      const candidateRepeaters = idToRepeatersById.get(rId);
      if (candidateRepeaters === undefined)
        return;

      // Strategy: Use geohash-based matching to find the closest repeater
      // 1. Filter by region if we can infer the coverage tile's region
      // 2. Among remaining candidates, find the one with geohash closest to coverage tile's geohash
      // 3. This naturally handles geographic proximity and prevents cross-region conflicts

      let finalCandidates = candidateRepeaters;

      // Step 1: Infer the coverage tile's region from nearby repeaters (if available)
      // This helps filter out cross-region conflicts
      const nearbyRepeaters = Array.from(idToRepeaters.values()).flat().filter(r => {
        const dist = haversineMiles(coverage.pos, r.pos);
        return dist < 50 && r.region; // Within 50 miles and has a region
      });

      // Find the most common region among nearby repeaters
      const nearbyRegionCounts = new Map();
      nearbyRepeaters.forEach(r => {
        const count = nearbyRegionCounts.get(r.region) || 0;
        nearbyRegionCounts.set(r.region, count + 1);
      });

      let inferredRegion = null;
      let maxCount = 0;
      nearbyRegionCounts.forEach((count, region) => {
        if (count > maxCount) {
          maxCount = count;
          inferredRegion = region;
        }
      });

        // Step 2: Filter by region if we inferred one (prevents cross-region conflicts)
      if (inferredRegion && finalCandidates.length > 1) {
        // Filter out repeaters that have a different region than inferred
        // Only keep: (1) repeaters with matching region, or (2) repeaters with no region
        const regionFiltered = finalCandidates.filter(r => {
          return !r.region || r.region === inferredRegion;
        });

        if (regionFiltered.length > 0) {
          finalCandidates = regionFiltered;
        }
      }

      // Step 3: Use geohash-based matching to find the closest repeater
      // This uses longest common prefix of geohashes, with distance as tiebreaker
      const bestRepeater = getBestRepeaterByGeohash(coverageGeohash, finalCandidates);
      bestRepeater.hitBy.push(coverage);

      // Store the inferred region on the coverage object (for edge visibility filtering)
      // Use the best repeater's region if available, otherwise use the inferred region
      if (!coverage.region) {
        coverage.region = bestRepeater.region || inferredRegion || null;
      }

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

// // Update drivers list content
// function updateDriversList(contentDiv) {
//   if (!nodes || !nodes.drivers) {
//     contentDiv.innerHTML = '<div style="padding: 20px; color: #e2e8f0; text-align: center;">No driver data available.<br/>Please refresh the map first.</div>';
//     return;
//   }

//   const drivers = nodes.drivers || [];

//   if (drivers.length === 0) {
//     contentDiv.innerHTML = `<div style="padding: 20px; color: #e2e8f0; text-align: center;">
//       No drivers found.<br/><br/>
//       <div style="font-size: 11px; color: #9ca3af; margin-top: 8px;">
//         Drivers are tracked from wardrive app users.
//       </div>
//     </div>`;
//     return;
//   }

//   // Create simple concise list
//   let html = '<div style="padding: 8px;">';

//   drivers.forEach((driver) => {
//     const heardPercent = driver.heardPercent ?? (driver.count > 0 ? ((driver.heard || 0) / driver.count * 100) : 0);
//     const heard = driver.heard || 0;
//     const lost = driver.lost || 0;
//     const total = driver.count;
//     const percentText = `${Math.round(heardPercent * 10) / 10}%`;

//     // Color based on success rate (green for high, red for low)
//     const color = heardPercent >= 75 ? '#34d399' : heardPercent >= 50 ? '#fbbf24' : '#f87171';

//     html += `<div style="padding: 8px 12px; color: #e2e8f0; border-bottom: 1px solid #4a5568; font-size: 13px;">
//       <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
//         <div style="display: flex; gap: 12px; align-items: center;">
//           <span style="font-weight: 500;">${escapeHtml(driver.name)}</span>
//         </div>
//         <span style="color: #34d399; font-weight: 600; font-size: 13px;">${total}</span>
//       </div>
//       <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #9ca3af;">
//         <span>${heard} heard, ${lost} missed</span>
//         <span style="color: ${color}; font-weight: 600;">${percentText}</span>
//       </div>
//     </div>`;
//   });

//   html += '</div>';
//   contentDiv.innerHTML = html;
// }

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
      const [lat, lon] = posFromHash(s.name);
      const samplePos = [lat, lon];
      // Always filter by distance (use default if maxDistanceMiles is 0)
      // Default to 2500 miles if not configured (reasonable default for USA)
      const maxDistance = maxDistanceMiles > 0 ? maxDistanceMiles : 2500;
      const distance = haversineMiles(centerPos, samplePos);
      if (distance > maxDistance) {
        return; // Skip samples outside the mileage range
      }
      // Only show samples that have a corresponding coverage tile
      // Individual samples use 8-char geohash, coverage uses 6-char geohash
      const coverageKey = s.name.substring(0, 6);
      if (!hashToCoverage || !hashToCoverage.has(coverageKey)) {
        return; // Skip samples without a coverage tile
      }
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

  // // Build query string from driver filters
  // const params = new URLSearchParams();
  // if (driverFilters && Object.keys(driverFilters).length > 0) {
  //   Object.keys(driverFilters).forEach(key => {
  //     if (driverFilters[key] !== null && driverFilters[key] !== "") {
  //       params.append(key, driverFilters[key]);
  //     }
  //   });
  // }

  // const url = params.toString() ? `${endpoint}?${params.toString()}` : endpoint;
  const url = endpoint;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  buildIndexes(nodes);
  renderNodes(nodes);

  // // Update drivers list if it's open
  // const driversList = document.getElementById("drivers-list");
  // const driversContent = document.getElementById("drivers-list-content");
  // if (driversList && driversContent && driversList.style.display !== "none") {
  //   updateDriversList(driversContent);
  // }
}
