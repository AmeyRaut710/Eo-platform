/**
 * app.js — EO Platform Frontend
 *
 * Responsibilities:
 *  - Initialize Leaflet map centered on Hyderabad
 *  - Poll backend for status & metadata
 *  - Load COG tiles from TiTiler
 *  - Layer switching (Satellite / Streets / NDVI)
 *  - Coordinate display, zoom level, pyramid highlight
 *  - Search (Nominatim geocoding)
 *  - Toast notifications
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_URL  = window.location.origin;
const COG_PATH     = "file:///path/to/backend/data/output_cog.tif"; // updated by /api/tilejson
const HYDERABAD    = [17.3850, 78.4867];
const DEFAULT_ZOOM = 10;
const POLL_MS      = 4000;  // status poll interval

// ── State ─────────────────────────────────────────────────────────────────────
let map, cogLayer, inputOverlay, activeLayerName = "satellite";
let tilejsonCache = null;

// ══════════════════════════════════════════════════════════════════════════════
// MAP INITIALISATION
// ══════════════════════════════════════════════════════════════════════════════

function initMap() {
  map = L.map("map", {
    center: HYDERABAD,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    attributionControl: false,
  });

  // No external basemap is added here — only the COG layer is displayed.

  // ── Scale bar ─────────────────────────────────────────────────────────────
  L.control.scale({ imperial: false }).addTo(map);

  // ── Events ────────────────────────────────────────────────────────────────
  map.on("zoom",       updateZoomInfo);
  map.on("mousemove",  updateCoords);
  map.on("click",      onMapClick);
  map.on("zoomend",    updatePyramidLevel);

  updateZoomInfo();
  updatePyramidLevel();
}

// ══════════════════════════════════════════════════════════════════════════════
// COG / TITILER LAYER
// ══════════════════════════════════════════════════════════════════════════════

async function loadCOGLayer() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/cog/tilejson`);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const tj   = await res.json();
    tilejsonCache = tj;

    if (cogLayer) map.removeLayer(cogLayer);

    cogLayer = L.tileLayer(tj.tiles[0], {
      minZoom:     tj.minzoom || 5,
      maxZoom:     tj.maxzoom || 18,
      attribution: "",
      opacity:     1,
      tileSize:    256,
      keepBuffer:  4,
    });

    cogLayer.addTo(map);
    fitToBounds(tj.bounds);

    // If an input preview overlay exists (before conversion), remove it
    if (inputOverlay) {
      try { map.removeLayer(inputOverlay); } catch (e) {}
      inputOverlay = null;
    }

    showToast("COG layer loaded ✓", "success");
    return tj;
  } catch (e) {
    console.warn("COG layer not available:", e.message);
    showToast("TiTiler not reachable — showing base map", "info");
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYER SWITCHER
// ══════════════════════════════════════════════════════════════════════════════

function activateLayer(name) {
  if (cogLayer) map.removeLayer(cogLayer);

  activeLayerName = name;
  document.querySelectorAll(".topbar__actions .pill-btn").forEach(b => b.classList.remove("active"));

  if (name === "satellite") {
    document.getElementById("btnSatellite").classList.add("active");
    if (cogLayer) cogLayer.addTo(map);
    else showToast("COG layer not yet loaded", "info");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKEND STATUS POLLING
// ══════════════════════════════════════════════════════════════════════════════

async function pollStatus() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/status`);
    const data = await res.json();

    setBadge("badgeBackend", "OK", "ok");

    setBadge("badgeInput",   data.input_exists ? "Found" : "Missing",
                             data.input_exists ? "ok"    : "error");
    setBadge("badgeCOG",     data.cog_exists   ? `${data.cog_size_mb} MB` : "Not found",
                             data.cog_exists   ? "ok"    : "warn");

    document.getElementById("progressBar").style.width  = data.progress + "%";
    document.getElementById("statusMsg").textContent    = data.message || "—";

    const dot = document.getElementById("statusDot");
    if (data.error)          dot.className = "card__dot error";
    else if (data.running)   dot.className = "card__dot warn";
    else if (data.done)      dot.className = "card__dot ok";
    else                     dot.className = "card__dot";

    // If an input TIFF exists but no COG yet, trigger processing automatically
    if (data.input_exists && !data.cog_exists && !data.running) {
      // Start conversion once (backend will guard against duplicate runs)
      showToast("Starting conversion automatically", "info");
      triggerProcessing();
    }

    // Load COG layer when COG is ready
    if (data.cog_exists && !cogLayer) {
      await loadCOGLayer();
      await loadMetadata();
    }

  } catch {
    setBadge("badgeBackend", "Offline", "error");
    document.getElementById("statusMsg").textContent = "Cannot reach backend";
  }
}

async function checkTiTiler() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/titiler/health`, { signal: AbortSignal.timeout(2000) });
    setBadge("badgeTitiler", res.ok ? "OK" : "Error", res.ok ? "ok" : "error");
  } catch {
    setBadge("badgeTitiler", "Offline", "error");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// METADATA DISPLAY
// ══════════════════════════════════════════════════════════════════════════════

async function loadMetadata() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/info`);
    if (!res.ok) return;
    const info = await res.json();

    setText("metaWidth",   info.width?.toLocaleString() ?? "—");
    setText("metaHeight",  info.height?.toLocaleString() ?? "—");
    setText("metaBands",   info.bands ?? "—");
    setText("metaCRS",     info.crs ?? "—");
    setText("metaSize",    info.size_mb ? `${info.size_mb} MB` : "—");
    setText("metaOvr",     info.overviews?.length ? info.overviews.join(", ") : "None");
    setText("metaCenter",
      info.center
        ? `${info.center.lat.toFixed(4)}°, ${info.center.lon.toFixed(4)}°`
        : "—"
    );

    if (info.center) {
      map.setView([info.center.lat, info.center.lon], DEFAULT_ZOOM);
    }
  } catch { /* metadata not yet available */ }
}


// Load input preview image and add an image overlay to the map
async function loadInputPreview() {
  try {
    const infoRes = await fetch(`${BACKEND_URL}/api/input/info`);
    if (!infoRes.ok) return;
    const info = await infoRes.json();

    const imgRes = await fetch(`${BACKEND_URL}/api/input/preview`);
    if (!imgRes.ok) return;
    const blob = await imgRes.blob();
    const url = URL.createObjectURL(blob);

    // bounds = [west, south, east, north]
    const bounds = info.bounds_wgs84;
    if (inputOverlay) { try { map.removeLayer(inputOverlay); } catch (e) {} }
    inputOverlay = L.imageOverlay(url, [[bounds[1], bounds[0]], [bounds[3], bounds[2]]], { opacity: 1 }).addTo(map);
    fitToBounds(bounds);
    showToast("Input preview loaded", "success");
  } catch (e) {
    console.warn("Failed to load input preview:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TRIGGER PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

async function triggerProcessing() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/process`, { method: "POST" });
    const data = await res.json();
    showToast(data.message, res.ok ? "success" : "error");
  } catch {
    showToast("Cannot reach backend", "error");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOCODING SEARCH (Nominatim)
// ══════════════════════════════════════════════════════════════════════════════

async function searchLocation(query) {
  if (!query.trim()) return;

  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + " Hyderabad India")}&format=json&limit=1`;

  try {
    const res    = await fetch(url, { headers: { "Accept-Language": "en" } });
    const results = await res.json();

    if (!results.length) {
      showToast("Location not found", "error");
      return;
    }

    const { lat, lon, display_name } = results[0];
    map.setView([+lat, +lon], 14);

    // Drop a small marker
    const marker = L.circleMarker([+lat, +lon], {
      radius:      8,
      color:       "#00e5ff",
      fillColor:   "#00e5ff",
      fillOpacity: 0.4,
      weight:      2,
    }).addTo(map);

    marker.bindPopup(
      `<span style="font-family:'Space Mono',monospace;font-size:11px;">${display_name}</span>`,
      { className: "dark-popup" }
    ).openPopup();

    setTimeout(() => map.removeLayer(marker), 8000);
    showToast(`Flew to: ${results[0].display_name.split(",")[0]}`, "success");

  } catch {
    showToast("Geocoding failed", "error");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function updateZoomInfo() {
  if (!map) return;
  document.getElementById("zoomLevel").textContent = map.getZoom();
}

function updateCoords(e) {
  document.getElementById("cursorLat").textContent = e.latlng.lat.toFixed(5);
  document.getElementById("cursorLon").textContent = e.latlng.lng.toFixed(5);
}

function onMapClick(e) {
  // Show lat/lon in a popup briefly
  L.popup({ closeButton: false, className: "coord-popup" })
    .setLatLng(e.latlng)
    .setContent(
      `<span style="font-family:'Space Mono',monospace;font-size:11px;color:#00e5ff;">
        ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}
      </span>`
    )
    .openOn(map);
  setTimeout(() => map.closePopup(), 2500);
}

function updatePyramidLevel() {
  const z = map ? map.getZoom() : 0;
  const levels = document.querySelectorAll(".pyr-level");
  levels.forEach(el => el.classList.remove("active"));

  if      (z <= 5)  levels[0].classList.add("active");
  else if (z <= 10) levels[1].classList.add("active");
  else if (z <= 14) levels[2].classList.add("active");
  else              levels[3].classList.add("active");
}

function fitToBounds(bounds) {
  // bounds = [west, south, east, north]
  if (!bounds) return;
  const [w, s, e, n] = bounds;
  map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = "badge " + (cls || "");
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Toast notification ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════════

document.getElementById("btnSatellite").addEventListener("click", () => activateLayer("satellite"));
document.getElementById("btnProcess").addEventListener("click",   triggerProcessing);

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════

(async function boot() {
  initMap();

  // Initial checks
  await Promise.all([pollStatus(), checkTiTiler()]);

  // Start polling
  setInterval(pollStatus,    POLL_MS);
  setInterval(checkTiTiler,  POLL_MS * 2);

  showToast("EO Platform ready", "info");
})();
