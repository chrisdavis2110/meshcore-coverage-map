import {
  BufferUtils,
  Constants,
  Packet,
  WebBleConnection
} from "./mc/index.js";
import BufferReader from "./mc/buffer_reader.js";
// Import aes-js directly from CDN since it's only needed in wardrive.js
import aes from 'https://cdn.skypack.dev/aes-js@3.1.2';
// Import colord for color manipulation
import { colord } from 'https://cdn.skypack.dev/colord@2.9.3';
import {
  ageInDays,
  centerPos,
  coverageKey,
  geo,
  isValidLocation,
  loadConfig,
  maxDistanceMiles,
  sampleKey,
  posFromHash
} from "./shared.js";

// Fade a color by desaturating and lightening it
function fadeColor(color, amount) {
  const c = colord(color);
  const v = c.toHsv().v;
  return c.desaturate(amount).lighten(amount * (1 - (v / 255))).toHex();
}

// --- DOM helpers ---
const $ = id => document.getElementById(id);
const statusEl = $("status");
const deviceNameEl = $("deviceName");
const channelInfoEl = $("channelInfo");
const lastSampleInfoEl = $("lastSampleInfo"); // May be null in simplified UI
const currentTileEl = $("currentTileHash"); // May be null in simplified UI
const currentNeedsPingEl = $("currentNeedsPing"); // May be null in simplified UI
const mapEl = $("map");
const controlsSection = $("controls"); // May be null in simplified UI
const intervalSection = $("interval-controls"); // May be null in simplified UI
const ignoredRepeaterId = $("ignoredRepeaterId");
const logBody = $("logBody"); // May be null in simplified UI
const debugConsole = $("debugConsole"); // May be null in simplified UI

const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn"); // May be null in simplified UI
const sendPingBtn = $("sendPingBtn");
const autoToggleBtn = $("autoToggleBtn");
const clearLogBtn = $("clearLogBtn"); // May be null in simplified UI
const pingModeSelect = $("pingModeSelect"); // May be null in simplified UI
const intervalSelect = $("intervalSelect"); // May be null in simplified UI
const minDistanceSelect = $("minDistanceSelect"); // May be null in simplified UI
const ignoredRepeaterBtn = $("ignoredRepeaterBtn");

// Channel key is derived from the channel hashtag.
// Channel hash is derived from the channel key.
// If you change the channel name, these must be recomputed.
const wardriveChannelHash = parseInt("e0", 16);
const wardriveChannelKey = BufferUtils.hexToBytes("4076c315c1ef385fa93f066027320fe5");
const wardriveChannelName = "#wardrive";
const refreshTileAge = 1; // Tiles older than this (days) will get pinged again.

// --- Global Init ---
const utf8decoder = new TextDecoder(); // default 'utf-8'
const repeatEmitter = new EventTarget();
// Map will be initialized in onLoad after config loads
let map = null;

// Layers will be initialized in onLoad after map is created
let osm = null;
let coverageLayer = null;
let pingLayer = null;
let currentLocMarker = L.circleMarker([0, 0], {
    radius: 3,
    weight: 0,
    color: "red",
    fillOpacity: .8,
    interactive: false,
    pane: "tooltipPane"
  });

function setStatus(text, color = null) {
  statusEl.textContent = text;
  log(`status: ${text}`);
  statusEl.className = "font-semibold " + (color ?? "");
}

function log(msg) {
  // const entry = document.createElement('pre');
  // entry.textContent = msg;
  // debugConsole.appendChild(entry);

  console.log(msg);
}

// --- State ---
const LOG_KEY = "meshcoreWardriveLogV1";
const IGNORED_ID_KEY = "meshcoreWardriveIgnoredIdV1"

const state = {
  connection: null,
  selfInfo: null,
  wardriveChannel: null,
  pingMode: "fill",
  running: false,
  autoTimerId: null,
  lastSample: null, // { lat, lon, timestamp }
  wakeLock: null,
  ignoredId: null, // Allows a repeater to be ignored.
  coveredTiles: new Set(),
  coveredTilesWithAge: new Map(), // tileId -> timestamp when it was marked as covered
  coverageTiles: new Map(), // tileId -> { o: 0|1, h: 0|1, a: ageInDays }
  tileCoverageData: new Map(), // tileId -> { heard, lost, successRate } from server coverage data
  locationTimer: null,
  lastPosUpdate: 0, // Timestamp of last location update.
  currentPos: [0, 0],
  log: [],
};

// --- Utility functions ---
function getIntervalMinutes() {
  return parseFloat(intervalSelect?.value || "0.5");
}

function getMinDistanceMiles() {
  return parseFloat(minDistanceSelect?.value || "0.5");
}

function formatIsoLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function successRateToColor(rate) {
    // Clamp rate to 0-1
    const clampedRate = Math.max(0, Math.min(1, rate));

    let red, green, blue;

    if (clampedRate >= 0.8) {
      // Dark green (0, 100, 0) to lighter green (50, 150, 50) (80-100%)
      // Making light green closer to dark green
      const t = (clampedRate - 0.8) / 0.2;       // 0 to 1
      red = Math.round(0 + (50 - 0) * t);        // 0 -> 50
      green = Math.round(100 + (150 - 100) * t); // 100 -> 150
      blue = Math.round(0 + (50 - 0) * t);       // 0 -> 50
    } else if (clampedRate >= 0.6) {
      // Light green (50, 150, 50) to orange (255, 165, 0) (60-80%)
      const t = (clampedRate - 0.6) / 0.2;        // 0 to 1
      red = Math.round(50 + (255 - 50) * t);      // 50 -> 255
      green = Math.round(150 + (165 - 150) * t);  // 150 -> 165
      blue = Math.round(50 - 50 * t);             // 50 -> 0
    } else if (clampedRate >= 0.4) {
      // Orange (255, 165, 0) to red-orange (255, 100, 0) (40-60%)
      const t = (clampedRate - 0.4) / 0.2;          // 0 to 1
      red = 255;                                    // 255
      green = Math.round(165 + (100 - 165) * t);    // 165 -> 100
      blue = 0;                                     // 0
    } else if (clampedRate >= 0.2) {
      // Red-orange (255, 100, 0) to red (255, 0, 0) (20-40%)
      const t = (clampedRate - 0.2) / 0.2;       // 0 to 1
      red = 255;                                 // 255
      green = Math.round(100 - 100 * t);         // 1000 -> 0
      blue = 0;                                  // 0
    } else {
      // Red (255, 0, 0) (0-20%)
      red = 255;                      // 255
      green = 0;                      // 0
      blue = 0;                       // 0
    }

    // Convert to hex
    const toHex = (n) => {
      const hex = n.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };

    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
  }

// --- Coverage Functions ---
async function refreshCoverageData() {
    try {
        // Fetch data from /get-nodes (includes coverage, samples, and repeaters)
        const resp = await fetch("/get-nodes", { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const nodesData = await resp.json();

        // Extract coverage data (nodesData.coverage uses 'id' instead of 'hash', 'rcv' instead of 'heard')
        const coverageData = nodesData.coverage || [];
        const samplesData = nodesData.samples || [];

        // Get tile IDs from both coverage and samples (like the old /get-wardrive-coverage endpoint)
        const coveredTilesSet = new Set();
        coverageData.forEach(c => coveredTilesSet.add(c.id));
        samplesData.forEach(s => coveredTilesSet.add(s.id)); // Samples also have 'id' as the 6-char geohash
        const coveredTiles = Array.from(coveredTilesSet);

        log(`Got ${coveredTiles.length} covered tiles from service (${coverageData.length} from coverage, ${samplesData.length} from samples).`);

        // Store coverage data for border color calculation
        coverageData.forEach(c => {
          // /get-nodes uses 'rcv' for heard, 'id' for hash
          const heard = c.rcv || 0;
          const lost = c.lost || 0;
          const totalSamples = heard + lost;
          const successRate = totalSamples > 0 ? heard / totalSamples : 0;
          state.tileCoverageData.set(c.id, {
            heard: heard,
            lost: lost,
            successRate: successRate
          });
        });

        // Samples use 'heard' and 'lost' fields directly
        samplesData.forEach(s => {
          if (!state.tileCoverageData.has(s.id)) {
            // Only add if not already in coverage data
            const heard = s.heard || 0;
            const lost = s.lost || 0;
            const totalSamples = heard + lost;
            const successRate = totalSamples > 0 ? heard / totalSamples : 0;
            state.tileCoverageData.set(s.id, {
              heard: heard,
              lost: lost,
              successRate: successRate
            });
          }
        });

        const now = Date.now();
        // Server returns tiles from last 3 days, so assume they're at least 1 day old
        // to be conservative (existing tiles might be older)
        const conservativeAge = now - (refreshTileAge * 24 * 60 * 60 * 1000);
        coveredTiles.forEach(x => {
          state.coveredTiles.add(x);
          // Track when we learned about this tile
          // For existing tiles, use conservative age (refreshTileAge days ago)
          // This ensures old tiles will be pinged again if they're actually old
          if (!state.coveredTilesWithAge.has(x)) {
            state.coveredTilesWithAge.set(x, conservativeAge);
          }
        });
      } catch (e) {
        console.error("Getting coverage failed", e);
        setStatus("Get coverage failed", "text-red-300");
      }
}

// Merge coverage state: o (observed), h (heard), a (age)
// Prefer observed over heard, prefer newest age
function mergeCoverage(id, value) {
  const prev = state.coverageTiles.get(id);
  if (!prev) {
    state.coverageTiles.set(id, value);
    return;
  }

  // o is 0|1 for "observed" -- prefer observed.
  // h is 0|1 for "heard" -- prefer heard.
  // a is "age in days" -- prefer newest.
  prev.o = Math.max(value.o, prev.o);
  prev.h = Math.max(value.h, prev.h);
  prev.a = Math.min(value.a, prev.a);
}

function getCoverageBoxMarker(tileId) {
  function getMarkerColor(info) {
    if (info.o)
      return '#398821' // Observed - Green
    if (info.h)
      return '#FEAA2C' // Repeated - Orange
    return '#E04748' // Miss - Red
  }

  const info = state.coverageTiles.get(tileId) || { o: 0, h: 0, a: refreshTileAge + 1 };
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(tileId);

  // Get border color from coverage data if available, otherwise use marker color
  let borderColor;
  const coverageData = state.tileCoverageData.get(tileId);
  if (coverageData) {
    // Coverage data exists - use success rate to determine border color
    const totalSamples = coverageData.heard + coverageData.lost;
    if (totalSamples > 0) {
      // Use success rate to determine border color (green/orange/red gradient)
      borderColor = successRateToColor(coverageData.successRate);
    } else {
      // Coverage data exists but no samples yet - use neutral gray
      borderColor = '#6A6A6A';
    }
  } else {
    // No coverage data for this tile - use neutral gray
    borderColor = '#6A6A6A';
  }

  const color = getMarkerColor(info);
  const fresh = info.a <= refreshTileAge;
  const fillColor = fresh ? color : fadeColor(color, .4);
  const finalFillColor = (!fresh && info.o === 0 && info.h === 0) ? '#6A6A6A' : fillColor;
  const fillOpacity = finalFillColor === '#6A6A6A' ? 0.25 : 0.85;
  const finalBorderColor = (!fresh && info.o === 0 && info.h === 0) ? borderColor : color;

  const style = {
    color: finalBorderColor,
    weight: 1,
    fillColor: finalFillColor,
    fillOpacity: fillOpacity,
    pane: "overlayPane",
    interactive: false
  };
  return L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
}

function addCoverageBox(tileId) {
  coverageLayer.addLayer(getCoverageBoxMarker(tileId));
}

function redrawCoverage() {
  coverageLayer.clearLayers();
  state.coveredTiles.forEach(c => {
    addCoverageBox(c);
  });
}

// --- Ping history and markers ---
async function getSample(sampleId) {
  try {
    const resp = await fetch(`/get-samples?p=${sampleId.substring(0, 6)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.keys?.find(s => s.name === sampleId);
  } catch (e) {
    console.error("Failed to get sample", e);
    return null;
  }
}

function addPingHistory(ping) {
  const existing = pingLayer.getLayers().find(m => m.ping?.hash === ping.hash);
  if (existing) {
    pingLayer.removeLayer(existing);
  }
  const marker = addPingMarker(ping);
  pingLayer.addLayer(marker);
}

function addPingMarker(ping) {
  function getPingColor(p) {
    if (p.observed === true)
      return '#398821' // Observed - Green
    if (p.heard == true)
      return '#FEAA2C' // Repeated - Orange
    if (p.heard === false)
      return '#E04748' // Miss - Red
    return "#999999"; // Unknown - Gray
  }

  const pos = posFromHash(ping.hash);
  const pingMarker = L.circleMarker(pos, {
    radius: 4,
    weight: 0.75,
    color: "white",
    fillColor: getPingColor(ping),
    fillOpacity: 1,
    pane: "markerPane",
    className: "marker-shadow",
    interactive: false
  });
  pingMarker.ping = ping;
  return pingMarker;
}

// --- Local storage log ---
function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) {
      state.log = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Failed to load wardrive log", e);
  }
  renderLog();
}

function saveLog() {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(state.log));
  } catch (e) {
    console.warn("Failed to save wardrive log", e);
  }
}

function addLogEntry(entry) {
  state.log.push(entry);
  // Keep it from growing forever
  const maxEntries = 50;
  if (state.log.length > maxEntries) {
    state.log.splice(0, state.log.length - maxEntries);
  }
  saveLog();
  renderLog();
}

function renderLog() {
  if (!logBody) return; // Log table not present in simplified UI
  logBody.innerHTML = "";
  const rows = state.log.reverse(); // Newest first
  for (const entry of rows) {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-900/60";
    const skipped = entry.skipped ?? false;

    const cells = [
      formatIsoLocal(entry.timestamp),
      entry.lat?.toFixed(4) ?? "",
      entry.lon?.toFixed(4) ?? "",
      entry.mode ?? "",
      entry.distanceMiles != null ? entry.distanceMiles.toFixed(1) : "",
      entry.sentToMesh ? "✅" : skipped ? "⊗" : "❌",
      entry.sentToService ? "✅" : skipped ? "⊗" : "❌",
      entry.notes ?? "",
    ];

    for (const text of cells) {
      const td = document.createElement("td");
      td.className = "px-2 py-1 align-top";
      td.textContent = text;
      tr.appendChild(td);
    }

    logBody.appendChild(tr);
  }
}

function updateLastSampleInfo() {
  if (!lastSampleInfoEl) return;
  if (!state.lastSample) {
    lastSampleInfoEl.textContent = "None yet";
    return;
  }
  const { lat, lon, timestamp } = state.lastSample;
  lastSampleInfoEl.textContent =
    `${lat.toFixed(4)}, ${lon.toFixed(4)} @ ` + formatIsoLocal(timestamp);
}

// --- Ignored Id ---
function loadIgnoredId() {
  try {
    state.ignoredId = null;
    const id = localStorage.getItem(IGNORED_ID_KEY);
    state.ignoredId = id ? id : null;
  } catch (e) {
    console.warn("Failed to load ignored id", e);
  }

  updateIgnoreId();
}

function promptIgnoredId() {
  const id = prompt("Enter repeater id to ignore.", state.ignoredId ?? '');

  // Was prompt cancelled?
  if (id === null)
    return;

  if (id && id.length !== 2) {
    alert(`Invalid id '${id}'. Must be 2 hex digits.`);
    return;
  }

  state.ignoredId = id ? id : null;
  localStorage.setItem(IGNORED_ID_KEY, id);
  updateIgnoreId();
}

function updateIgnoreId() {
  if (ignoredRepeaterId) ignoredRepeaterId.innerText = state.ignoredId ?? "<none>";
}

// --- Geolocation ---
async function startLocationTracking() {
  stopLocationTracking();
  await updateCurrentPosition(); // Run immediately, then on timer.
  state.locationTimer = setInterval(updateCurrentPosition, 1000);
}

function stopLocationTracking() {
  if (state.locationTimer) {
    clearInterval(state.locationTimer);
    state.locationTimer = null;
  }
}

async function updateCurrentPosition() {
  const pos = await getCurrentPosition();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  state.currentPos = [lat, lon];

  if (currentLocMarker) {
    currentLocMarker.setLatLng(state.currentPos);
  }
  if (map) {
    map.panTo(state.currentPos);
  }

  const coverageTileId = coverageKey(lat, lon);
  // Check if tile needs ping: not in coveredTiles OR older than refreshTileAge days
  const tileCoveredTime = state.coveredTilesWithAge.get(coverageTileId);
  const daysSinceCovered = tileCoveredTime ? (Date.now() - tileCoveredTime) / (1000 * 60 * 60 * 24) : Infinity;
  const needsPing = !state.coveredTiles.has(coverageTileId) || daysSinceCovered > refreshTileAge;
  if (currentTileEl) currentTileEl.innerText = coverageTileId;
  if (currentNeedsPingEl) currentNeedsPingEl.innerText = needsPing ? "✅" : "⛔";

  state.lastPosUpdate = Date.now();
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not available in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 5000,
      }
    );
  });
}

// Helper to ensure the location tracking timer stays running.
async function ensureCurrentPositionIsFresh() {
  const dt = Date.now() - state.lastPosUpdate;
  if (dt > 3000) {
    await startLocationTracking();
  }
}

// --- WakeLock helpers ---
async function acquireWakeLock() {
  // Bluefy-specfic -- it's a bit better when available.
  if ('setScreenDimEnabled' in navigator.bluetooth) {
    // This name is bad. setScreenDimEnabled(true) prevents screen locking.
    navigator.bluetooth.setScreenDimEnabled(true);
    log('setScreenDimEnabled(true)');
  } else {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        log('navigator.wakeLock acquired');

        state.wakeLock.addEventListener('release',
          () => log('navigator.wakeLock released'));

      } else {
        log('navigator.wakeLock not supported');
      }
    } catch (err) {
      console.error(`Could not obtain wake lock: ${err.name}, ${err.message}`);
    }
  }
}

async function releaseWakeLock() {
  if ('setScreenDimEnabled' in navigator.bluetooth) {
    navigator.bluetooth.setScreenDimEnabled(false);
    log('setScreenDimEnabled(false)');
  } else {
    if (state.wakeLock !== null) {
      state.wakeLock.release();
      state.wakeLock = null;
    }
  }
}

// --- Wardrive channel helpers ---
async function createWardriveChannel() {
  const create = window.confirm(
    `Channel "${wardriveChannelName}" not found on this device. Create it now?`
  );

  if (!create) {
    if (channelInfoEl) channelInfoEl.textContent = `No "${wardriveChannelName}" channel; ping disabled.`;
    throw new Error("Wardrive channel not created");
  }

  // Find a free channel index.
  const channels = await state.connection.getChannels();
  let idx = 0;
  while (idx < channels.length) {
    if (channels[idx].name === '')
      break;
    ++idx;
  }

  if (idx >= channels.length) {
    throw new Error("No free channel slots available");
  }

  // Derived secret for #wardrive 4076c315c1ef385fa93f066027320fe5
  const wardriveKey = new Uint8Array([
    0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
    0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
  ]);

  // Create and set the connection.
  const channel = { channelIdx: idx, name: wardriveChannelName, wardriveKey };
  await state.connection.setChannel(idx, wardriveChannelName, wardriveKey);
  return channel;
}

async function ensureWardriveChannel() {
  if (!state.connection) {
    throw new Error("Not connected");
  }

  if (state.wardriveChannel) {
    return state.wardriveChannel;
  }

  // Look for existing channel by name.
  let channel = await state.connection.findChannelByName(wardriveChannelName);
  let channelSecret = await state.connection.findChannelBySecret(wardriveChannelKey);

  if (!channel || !channelSecret) {
    channel = await createWardriveChannel();
  }

  if (channelInfoEl) channelInfoEl.textContent = `Using ${channel.name} on slot ${channel.channelIdx}`;
  state.wardriveChannel = channel;
  return channel;
}

// --- Ping logic ---
async function listenForRepeat(message, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const on = e => {
      const detail = e.detail;
      if (detail.text?.endsWith(message)) {
        cleanup();
        resolve(detail);
      } else {
        log(`Ignored repeat ${JSON.stringify(detail)}`);
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);

    function cleanup() {
      repeatEmitter.removeEventListener("repeat", on);
      if (timeout) clearTimeout(timeout);
    }

    repeatEmitter.addEventListener("repeat", on);
  });
}

async function sendPing({ auto = false } = {}) {
  if (!state.connection) {
    setStatus("Not connected", "text-red-300");
    return;
  }

  // Get the channel.
  let channel;
  try {
    channel = await ensureWardriveChannel();
  } catch (e) {
    console.warn(`Channel "${wardriveChannelName}" not available`, e);
    setStatus(`No "${wardriveChannelName}" channel`, "text-amber-300");
    return;
  }

  try {
    await ensureCurrentPositionIsFresh();
  } catch (e) {
    console.error("Get location failed", e);
    setStatus("Get location failed", "text-amber-300");
    return;
  }

  let pos = state.currentPos;
  if (!isValidLocation(pos)) {
    setStatus("Outside coverage area", "text-red-300");
    return;
  }

  // Until everything is migrated to use hash everywhere,
  // make sure the lat/lon in the ping is derived from the hash.
  const [rawLat, rawLon] = pos;
  const sampleId = sampleKey(rawLat, rawLon);
  const coverageTileId = sampleId.substring(0, 6);
  const [lat, lon] = posFromHash(sampleId);
  let distanceMilesValue = null;

  if (state.pingMode === "interval") {
    // Ensure minimum distance met for interval auto ping.
    const minMiles = getMinDistanceMiles();
    if (auto && state.lastSample && minMiles > 0) {
      distanceMilesValue = haversineMiles(
        [state.lastSample.lat, state.lastSample.lon], [lat, lon]);
      if (distanceMilesValue < minMiles) {
        log(`Min distance not met ${distanceMilesValue}, skipping.`);
        setStatus("Skipped ping", "text-amber-300");
        addLogEntry({
          timestamp: new Date().toISOString(),
          lat,
          lon,
          mode: "auto",
          distanceMiles: distanceMilesValue,
          skipped: true,
          sentToMesh: false,
          sentToService: false,
        });
        return;
      }
    }
  } else {
    // Ensure ping is needed in the current tile.
    const tileCoveredTime = state.coveredTilesWithAge.get(coverageTileId);
    const daysSinceCovered = tileCoveredTime ? (Date.now() - tileCoveredTime) / (1000 * 60 * 60 * 24) : Infinity;
    const needsPing = !state.coveredTiles.has(coverageTileId) || daysSinceCovered > refreshTileAge;
    if (auto && !needsPing) {
      setStatus("No ping needed", "text-amber-300");
      return;
    }
  }

  setStatus("Sending ping…", "text-sky-300");

  let text = `${lat.toFixed(4)} ${lon.toFixed(4)}`;
  if (state.ignoredId !== null) text += ` ${state.ignoredId}`;
  let sentToMesh = false;
  let sentToService = false;
  let notes = "";

  try {
    // Send mesh message: "<lat> <lon> [<id>]".
    await state.connection.sendChannelTextMessage(channel.channelIdx, text);
    sentToMesh = true;
    log("Sent MeshCore wardrive ping:", text);
  } catch (e) {
    console.error("Mesh send failed", e);
    setStatus("Mesh send failed", "text-red-300");
    notes = "Mesh Fail: " + e.message;
  }

  let repeat = null;
  if (sentToMesh) {
    try {
      repeat = await listenForRepeat(text);
      log(`Heard repeat from ${repeat.repeater}`);
    } catch {
      log("Didn't hear a repeat in time, assuming lost.");
    }
  }

  if (sentToMesh) {
    // Send sample to service.
    try {
        const data = { lat, lon };
        // Include driver name (device name or "wardrive-user")
        const driverName = state.selfInfo?.name || "wardrive-user";
        data.drivers = driverName;

        if (repeat) {
          data.path = [repeat.repeater];
          data.observed = true; // We heard a repeat, so this is observed
          // Include full public key if available
          if (repeat.pubkey) {
            data.repeaterPubkey = repeat.pubkey;
          }
          if (!repeat.hitMobileRepeater) {
            // Don't include signal info when using a mobile repeater.
            data.snr = repeat.lastSnr;
            data.rssi = repeat.lastRssi;
          }
        } else {
          // No repeat heard - explicitly mark as not observed (miss) for driver stats
          data.observed = false;
        }

      await fetch("/put-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      sentToService = true;
    } catch (e) {
      console.error("Service POST failed", e);
      setStatus("Web send failed", "text-red-300");
      notes = "Web Fail: " + e.message;
    }

    // Update the tile state immediately.
    // Setting "age" to the cutoff so it stops getting pinged.
    const heard = repeat?.repeater !== undefined;
    mergeCoverage(coverageTileId, { o: 0, h: heard ? 1 : 0, a: refreshTileAge });
  }

  // Even if sending the sample POST failed, consider this
  // the new 'last sample' to avoid spam.
  const nowIso = new Date().toISOString();
  state.lastSample = { lat, lon, timestamp: nowIso };
  updateLastSampleInfo();

  if (!state.coveredTiles.has(coverageTileId)) {
    state.coveredTiles.add(coverageTileId);
    state.coveredTilesWithAge.set(coverageTileId, Date.now());
    addCoverageBox(coverageTileId);
  } else {
    // Update the age timestamp when we ping it again
    state.coveredTilesWithAge.set(coverageTileId, Date.now());
  }

  // Wait a bit, then check if the sample was heard
  setTimeout(async () => {
    const sample = await getSample(sampleId);
    const ping = { hash: sampleId };

    if (sample) {
      ping.observed = sample.metadata?.observed ?? sample.observed ?? false;
      ping.heard = (sample.metadata?.path?.length > 0) ?? (sample.path?.length > 0);
      mergeCoverage(coverageTileId, {
        o: ping.observed ? 1 : 0,
        h: ping.heard ? 1 : 0,
        a: ageInDays(sample.metadata?.time ?? sample.time)
      });
    }

    addCoverageBox(coverageTileId);
    addPingHistory(ping);
  }, 2500);

  // Log result.
  const entry = {
    timestamp: new Date().toISOString(),
    lat,
    lon,
    mode: auto ? "auto" : "manual",
    distanceMiles: distanceMilesValue,
    sentToMesh,
    sentToService,
    notes,
  };

  addLogEntry(entry);

  if (sentToMesh) {
    setStatus(auto ? "Auto ping sent" : "Ping sent", "text-emerald-300");
  }
}

// --- Auto mode ---
function updateAutoButton() {
  if (state.running) {
    autoToggleBtn.textContent = "Stop Auto Ping";
    autoToggleBtn.classList.remove("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
  } else {
    autoToggleBtn.textContent = "Start Auto Ping";
    autoToggleBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
  }
}

function stopAutoPing() {
  if (state.autoTimerId != null) {
    clearInterval(state.autoTimerId);
    state.autoTimerId = null;
  }
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
}

async function startAutoPing() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }

  const minutes = getIntervalMinutes();
  if (!minutes || minutes <= 0) {
    alert("Please choose a valid ping interval.");
    return;
  }

  stopAutoPing();

  state.running = true;
  updateAutoButton();

  let intervalMs = 10 * 1000;
  if (state.pingMode === "interval") {
    intervalMs = minutes * 60 * 1000;
  }

  // TODO: Maybe this should be fetched periodically.
  await refreshCoverageData();
  redrawCoverage();

  setStatus("Auto mode started", "text-emerald-300");

  // Send first ping immediately, then on interval.
  sendPing({ auto: true }).catch(console.error);
  state.autoTimerId = setInterval(() => {
    sendPing({ auto: true }).catch(console.error);
  }, intervalMs);

  await acquireWakeLock();
}

// --- Connection handling ---
async function handleConnect() {
  if (state.connection) {
    return;
  }

  if (!("bluetooth" in navigator)) {
    alert("Web Bluetooth not supported in this browser.");
    return;
  }

  setStatus("Connecting…", "text-sky-300");
  connectBtn.disabled = true;

  try {
    const connection = await WebBleConnection.open();

    // User cancelled device picker or no device selected
    if (!connection) {
        setStatus("No device selected", "text-amber-300");
        connectBtn.disabled = false;
        return;
      }

    state.connection = connection;

    // Add handlers
    connection.on("connected", onConnected);
    connection.on("disconnected", onDisconnected);
    connection.on(Constants.PushCodes.LogRxData, onLogRxData);
  } catch (e) {
    console.error("Failed to open BLE connection", e);
    setStatus("Failed to connect", "text-red-300");
    connectBtn.disabled = false;
  }
}

async function handleDisconnect() {
  if (!state.connection) return;
  try {
    await state.connection.close();
  } catch (e) {
    console.warn("Error closing connection", e);
  }
  // onDisconnected will be called from the BLE event
}

async function onConnected() {
  setStatus("Connected (syncing…)", "text-emerald-300");
  if (disconnectBtn) disconnectBtn.disabled = false;
  connectBtn.disabled = true;
  sendPingBtn.disabled = false;
  autoToggleBtn.disabled = false;
  if (controlsSection) controlsSection.classList.remove("hidden");

  try {
    try {
      await state.connection.syncDeviceTime();
    } catch {
      // Might not be supported.
    }

    const selfInfo = await state.connection.getSelfInfo();
    state.selfInfo = selfInfo;
    if (deviceNameEl) {
      deviceNameEl.textContent = selfInfo?.name
        ? `Device: ${selfInfo.name}`
        : "Device connected";
    }
    setStatus(
      `Connected to ${selfInfo?.name ?? "MeshCore"}`,
      "text-emerald-300"
    );

    // Try to ensure channel exists.
    try {
      await ensureWardriveChannel();
    } catch {
      // Will attempt again on ping.
    }
  } catch (e) {
    console.error("Error during initial sync", e);
    setStatus("Connected, but failed to init", "text-amber-300");
    await handleDisconnect();
  }
}

function onDisconnected() {
  stopAutoPing();

  // Remove handlers
  if (state.connection) {
    state.connection.off("connected", onConnected);
    state.connection.off("disconnected", onDisconnected);
    state.connection.off(Constants.PushCodes.LogRxData, onLogRxData);
  }

  if (deviceNameEl) deviceNameEl.textContent = "";
  if (channelInfoEl) channelInfoEl.textContent = "";
  if (disconnectBtn) disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  sendPingBtn.disabled = true;
  autoToggleBtn.disabled = true;
  if (controlsSection) controlsSection.classList.add("hidden");

  state.connection = null;
  state.wardriveChannel = null;

  log("Disconnected");
  setStatus("Disconnected", "text-red-300");
}

async function onLogRxData(frame) {
  const lastSnr = frame.lastSnr;
  const lastRssi = frame.lastRssi;
  let hitMobileRepeater = false;
  const packet = Packet.fromBytes(frame.raw);

  // Only care about flood messages to the wardrive channel.
  if (!packet.isRouteFlood()
    || packet.getPayloadType() != Packet.PAYLOAD_TYPE_GRP_TXT
    || packet.path.length == 0)
    return;

  // First repeater (ignoring mobile repeater).
  let firstRepeaterPrefix = packet.path[0];
  let firstRepeaterPubkey = null;

  // Try to look up full public key from contacts
  if (state.connection) {
    try {
      const contacts = await state.connection.getContacts();
      // Find contact matching the prefix (first byte of public key)
      const matchingContact = contacts.find(c => c.publicKey && c.publicKey[0] === firstRepeaterPrefix);
      if (matchingContact && matchingContact.publicKey) {
        // Convert 32-byte public key to 64-char hex string
        firstRepeaterPubkey = Array.from(matchingContact.publicKey)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
      }
    } catch (e) {
      console.debug("Failed to get contacts for pubkey lookup:", e);
    }
  }

  let firstRepeater = firstRepeaterPrefix.toString(16).padStart(2, '0');
  if (firstRepeater === state.ignoredId) {
    firstRepeaterPrefix = packet.path[1];
    firstRepeater = firstRepeaterPrefix?.toString(16).padStart(2, '0');
    hitMobileRepeater = true;

    // Try to look up full public key for second repeater too
    if (state.connection && firstRepeaterPrefix !== undefined) {
      try {
        const contacts = await state.connection.getContacts();
        const matchingContact = contacts.find(c => c.publicKey && c.publicKey[0] === firstRepeaterPrefix);
        if (matchingContact && matchingContact.publicKey) {
          firstRepeaterPubkey = Array.from(matchingContact.publicKey)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        }
      } catch (e) {
        console.debug("Failed to get contacts for pubkey lookup:", e);
      }
    }
  }

  // No valid path.
  if (firstRepeater === undefined)
    return;

  const reader = new BufferReader(packet.payload);
  const groupHash = reader.readByte();
  const mac = reader.readBytes(2); // Validate?
  const encrypted = reader.readRemainingBytes();

  // Invalid data for AES.
  if (encrypted.length % 16 !== 0)
    return;

  // Definitely not to wardrive channel.
  if (groupHash !== wardriveChannelHash)
    return;

  // Probably for wardrive, give it a try.
  try {
    const aesEcb = new aes.ModeOfOperation.ecb(wardriveChannelKey);
    const decrypted = aesEcb.decrypt(encrypted);
    const msgReader = new BufferReader(decrypted);
    msgReader.readBytes(5); // Skip Timestamp and Flags, remove trailing null padding.
    const msgText = utf8decoder.decode(msgReader.readRemainingBytes()).replace(/\0/g, '');
    repeatEmitter.dispatchEvent(new CustomEvent("repeat", {
      detail: {
        repeater: firstRepeater,
        pubkey: firstRepeaterPubkey, // Full public key if available
        text: msgText,
        hitMobileRepeater: hitMobileRepeater,
        lastSnr: lastSnr,
        lastRssi: lastRssi
      }
    }));
  } catch (e) {
    log("Failed to decrypt message:", e);
  }
}

// --- Event bindings ---
connectBtn.addEventListener("click", () => {
  handleConnect().catch(console.error);
});

if (disconnectBtn) {
  disconnectBtn.addEventListener("click", () => {
    handleDisconnect().catch(console.error);
  });
}

sendPingBtn.addEventListener("click", () => {
  sendPing({ auto: false }).catch(console.error);
});

autoToggleBtn.addEventListener("click", async () => {
  if (state.running) {
    stopAutoPing();
    setStatus("Auto mode stopped", "text-slate-300");
  } else {
    await startAutoPing();
  }
});

if (pingModeSelect) {
  pingModeSelect.addEventListener("change", async () => {
    const pingMode = pingModeSelect.value;

    if (state.pingMode === pingMode) {
      return;
    }

    stopAutoPing();
    state.pingMode = pingMode;
    if (intervalSection) {
      if (pingMode === "interval") {
        intervalSection.classList.remove("hidden");
      } else {
        intervalSection.classList.add("hidden");
      }
    }
  });
}

ignoredRepeaterBtn.addEventListener("click", promptIgnoredId);

if (clearLogBtn) {
  clearLogBtn.addEventListener("click", () => {
    if (!confirm("Clear local wardrive log?")) return;
    state.log = [];
    state.lastSample = null;
    updateLastSampleInfo();
    saveLog();
    renderLog();
  });
}

// Automatically release wake lock when the page is hidden.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    releaseWakeLock();
    stopLocationTracking();
  } else {
    await startLocationTracking();

    if (state.running)
      await acquireWakeLock();
  }
});

// Bluefy-specific.
if ('bluetooth' in navigator) {
  navigator.bluetooth.addEventListener('backgroundstatechanged',
    (e) => {
      const isBackground = e.target.value;
      if (isBackground == true && state.running) {
        stopAutoPing();
        setStatus('Lost focus, Stopped', 'text-amber-300');
      }
    });
}

export async function onLoad() {
  try {
    console.log('Wardrive: Starting onLoad...');

    // Load config from server first
    await loadConfig();

    // Initialize map with configured center position
    map = L.map('map', {
      worldCopyJump: true,
      dragging: true,
      scrollWheelZoom: true,
      touchZoom: true,
      boxZoom: false,
      keyboard: false,
      tap: false,
      zoomControl: false,
      doubleClickZoom: false
    }).setView(centerPos, 12);

    // Create and add tile layer
    osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 13,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Create map layers
    coverageLayer = L.layerGroup().addTo(map);
    pingLayer = L.layerGroup().addTo(map);

    // Add current location marker to map
    currentLocMarker.addTo(map);

    loadLog();
    loadIgnoredId();
    updateLastSampleInfo();
    updateAutoButton();

    console.log('Wardrive: Refreshing coverage data...');
    await refreshCoverageData();
    redrawCoverage();

    console.log('Wardrive: Starting location tracking...');
    await startLocationTracking();
    console.log('Wardrive: onLoad completed successfully');
  } catch (e) {
    console.error('Wardrive: Error in onLoad:', e);
    setStatus(`Error: ${e.message}`, "text-red-300");
    // Show error in UI
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent = `Error: ${e.message}`;
      statusEl.className = "font-semibold text-red-300";
    }
    throw e; // Re-throw so the HTML error handler can catch it
  }
}
