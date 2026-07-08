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
const BACKEND_URL  = "http://localhost:8000";
const TITILER_URL  = "http://localhost:8001";
const COG_PATH     = "file:///path/to/backend/data/output_cog.tif"; // updated by /api/tilejson
const HYDERABAD    = [17.3850, 78.4867];
const DEFAULT_ZOOM = 10;
const POLL_MS      = 4000;  // status poll interval

// ── State ─────────────────────────────────────────────────────────────────────
let map, cogLayer, activeLayerName = "satellite";
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
    minZoom: 2,
    maxZoom: 24
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

// No default layer loading on boot anymore, user must select an image.

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

    document.getElementById("progressBar").style.width  = data.progress + "%";
    document.getElementById("statusMsg").textContent    = data.message || "—";

    const dot = document.getElementById("statusDot");
    if (data.error)          dot.className = "card__dot error";
    else if (data.running)   dot.className = "card__dot warn";
    else if (data.done)      dot.className = "card__dot ok";
    else                     dot.className = "card__dot";

  } catch {
    setBadge("badgeBackend", "Offline", "error");
    document.getElementById("statusMsg").textContent = "Cannot reach backend";
  }
}

async function checkTiTiler() {
  try {
    const res = await fetch(`${TITILER_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
    setBadge("badgeTitiler", res.ok ? "OK" : "Error", res.ok ? "ok" : "error");
  } catch {
    setBadge("badgeTitiler", "Offline", "error");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// METADATA DISPLAY
// ══════════════════════════════════════════════════════════════════════════════

async function loadMetadata(id) {
  if (!id) return;
  try {
    const res  = await fetch(`${BACKEND_URL}/api/info/${id}`);
    if (!res.ok) return;
    const info = await res.json();

    setText("metaWidth",   info.resolution ? `${info.resolution.toFixed(2)}m` : "—"); // using resolution slot instead of width
    setText("metaHeight",  info.original_name ?? "—");
    setText("metaBands",   info.bands ?? "—");
    setText("metaCRS",     info.cog_path ?? "—");
    setText("metaSize",    info.file ?? "—");
    setText("metaOvr",     info.created_at ?? "—");
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

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-IMAGE SELECTION (DATASETS)
// ══════════════════════════════════════════════════════════════════════════════

async function loadDatasets() {
  try {
    const res = await fetch(`${BACKEND_URL}/datasets`);
    if (!res.ok) return;
    const datasets = await res.json();
    
    const container = document.getElementById("datasetList");

    container.innerHTML = "";
    
    if (datasets.length === 0) {
      container.innerHTML = '<div class="status-msg">No images found</div>';
      return;
    }
    
    datasets.forEach(ds => {
      const isProcessing = !ds.cog_path;
      const el = document.createElement("div");
      el.className = "dataset-card" + (isProcessing ? " processing" : "");
      if (isProcessing) {
          el.style.opacity = "0.6";
          el.style.borderLeftColor = "#ffb300";
      }
      el.innerHTML = `
        <div class="dataset-card__name">${ds.name}</div>
        <div class="dataset-card__path" title="${ds.original_name}">${ds.original_name}</div>
        ${isProcessing ? '<div style="color:#ffb300; font-size:10px; margin-top:4px;">Processing...</div>' : ''}
      `;
      if (!isProcessing) {
          el.addEventListener("click", () => selectDataset(ds, el));
      } else {
          el.addEventListener("click", () => alert("Image is still being converted to COG. Please wait..."));
      }
      container.appendChild(el);
    });
  } catch (e) {
    console.warn("Failed to load datasets:", e);
  }
}

let currentActiveDataset = null;

async function selectDataset(ds, element) {
  // Update active state
  document.querySelectorAll(".dataset-card").forEach(el => el.classList.remove("active"));
  if (element) element.classList.add("active");
  
  currentActiveDataset = ds;
  document.getElementById("layerOpsCard").style.display = "block";
  
  // Show loading overlay
  const loading = document.getElementById("loadingOverlay");
  if (loading) loading.classList.remove("hidden");
  
  try {
    // Collect active layer operations if any
    let queryParams = "";
    const activeTab = document.querySelector(".tab.active").getAttribute("data-tab");
    
    if (activeTab === "composite") {
        const r = document.getElementById("drop-r").textContent.trim() || "B04";
        const g = document.getElementById("drop-g").textContent.trim() || "B03";
        const b = document.getElementById("drop-b").textContent.trim() || "B02";
        queryParams = `?assets=${r},${g},${b}`;
    } else if (activeTab === "index") {
        const format = document.getElementById("selIndexFormat").value;
        let expr;
        let rescale;
        let exprAssets = [];
        if (format === "normalized") {
            const n1 = document.getElementById("drop-idx-n1").textContent.trim() || "B08";
            const n2 = document.getElementById("drop-idx-n2").textContent.trim() || "B04";
            const n3 = document.getElementById("drop-idx-n3").textContent.trim() || "B08";
            const n4 = document.getElementById("drop-idx-n4").textContent.trim() || "B04";
            
            if (n1 === "B08" && n2 === "B04" && n3 === "B08" && n4 === "B04") {
                queryParams = `?zarr_index=NDVI&colormap_name=rdylgn`;
            } else if (n1 === "B03" && n2 === "B08" && n3 === "B03" && n4 === "B08") {
                queryParams = `?zarr_index=NDWI&colormap_name=rdylgn`;
            } else {
                const uniqueAssets = [...new Set([n1, n2, n3, n4])];
                exprAssets = uniqueAssets.join(",");
                
                const idx1 = uniqueAssets.indexOf(n1) + 1;
                const idx2 = uniqueAssets.indexOf(n2) + 1;
                const idx3 = uniqueAssets.indexOf(n3) + 1;
                const idx4 = uniqueAssets.indexOf(n4) + 1;
                
                expr = encodeURIComponent(`(b${idx1}-b${idx2})/(b${idx3}+b${idx4})`);
                rescale = "-1,1";
                const cmap = "rdylgn";
                queryParams = `?expression=${expr}&assets=${exprAssets}&asset_as_band=true&colormap_name=${cmap}&rescale=${rescale}`;
            }
        } else {
            const r1 = document.getElementById("drop-idx-r1").textContent.trim() || "B08";
            const r2 = document.getElementById("drop-idx-r2").textContent.trim() || "B04";
            
            const uniqueAssets = [...new Set([r1, r2])];
            exprAssets = uniqueAssets.join(",");
            
            const idx1 = uniqueAssets.indexOf(r1) + 1;
            const idx2 = uniqueAssets.indexOf(r2) + 1;
            
            expr = encodeURIComponent(`(b${idx1}/b${idx2})`);
            rescale = "0,3";
            const cmap = "rdylgn";
            queryParams = `?expression=${expr}&assets=${exprAssets}&asset_as_band=true&colormap_name=${cmap}&rescale=${rescale}`;
        }
    }

    // 1. Fetch TileJSON (TiTiler endpoints)
    const res = await fetch(`${BACKEND_URL}/view/${ds.id}${queryParams}`);
    if (!res.ok) throw new Error("Failed to load tilejson");
    
    const tj = await res.json();
    tilejsonCache = tj;
    
    if (cogLayer) map.removeLayer(cogLayer);
    
    cogLayer = L.tileLayer(tj.tiles[0], {
      minZoom: tj.minzoom || 5,
      maxZoom: tj.maxzoom || 18,
      attribution: "",
      opacity: 1,
      tileSize: 256,
      keepBuffer: 4,
    });
    
    cogLayer.addTo(map);
    fitToBounds(tj.bounds);
    
    // 2. Load Metadata for this specific image
    await loadMetadata(ds.id);
    
    showToast(`Loaded ${ds.name}`, "success");
  } catch (e) {
    showToast("Error loading image", "error");
    console.error(e);
  } finally {
    if (loading) loading.classList.add("hidden");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYER OPERATIONS UI
// ══════════════════════════════════════════════════════════════════════════════

document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
        // Switch tab UI
        document.querySelectorAll(".tab").forEach(t => {
            t.classList.remove("active");
            t.style.color = "#555";
            t.style.border = "1px solid #222";
            t.style.background = "transparent";
        });
        tab.classList.add("active");
        tab.style.color = "#00e5ff";
        tab.style.border = "1px solid #00e5ff";
        tab.style.background = "rgba(0, 229, 255, 0.05)";
        
        // Switch content
        document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");
        document.getElementById("tab-" + tab.getAttribute("data-tab")).style.display = "block";
    });
});

// Drag and Drop Logic
let draggedItem = null;

document.querySelectorAll(".band-item").forEach(item => {
    item.addEventListener("dragstart", (e) => {
        draggedItem = e.target;
        e.dataTransfer.setData("text/plain", e.target.textContent);
        setTimeout(() => e.target.style.opacity = '0.5', 0);
    });
    
    item.addEventListener("dragend", (e) => {
        setTimeout(() => e.target.style.opacity = '1', 0);
        draggedItem = null;
    });
});

document.querySelectorAll(".drop-zone").forEach(zone => {
    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("drag-over");
    });
    
    zone.addEventListener("dragleave", () => {
        zone.classList.remove("drag-over");
    });
    
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        if (draggedItem) {
            zone.textContent = draggedItem.textContent;
            const bgClass = Array.from(draggedItem.classList).find(c => c.startsWith('bg-'));
            
            zone.classList.forEach(c => {
                if (c.startsWith('bg-')) zone.classList.remove(c);
            });
            
            if (bgClass) {
                zone.classList.add(bgClass);
                zone.classList.add('filled');
            }
        }
    });
});

document.getElementById("btnApplyComposite").addEventListener("click", () => {
    if (currentActiveDataset) selectDataset(currentActiveDataset, null);
});
document.getElementById("btnApplyIndex").addEventListener("click", () => {
    if (currentActiveDataset) selectDataset(currentActiveDataset, null);
});

document.getElementById("selIndexFormat").addEventListener("change", (e) => {
    if (e.target.value === "normalized") {
        document.getElementById("formula-normalized").style.display = "flex";
        document.getElementById("formula-ratio").style.display = "none";
    } else {
        document.getElementById("formula-normalized").style.display = "none";
        document.getElementById("formula-ratio").style.display = "flex";
    }
});


// triggerProcessing removed since scanning is fully automatic

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

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════

(async function boot() {
  initMap();

  // Initial checks
  await Promise.all([pollStatus(), checkTiTiler(), loadDatasets()]);

  // Start polling
  setInterval(pollStatus,    POLL_MS);
  setInterval(checkTiTiler,  POLL_MS * 2);
  setInterval(loadDatasets,  POLL_MS * 5); // poll for new datasets occasionally

  showToast("EO Platform ready", "info");
})();

// ══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING & DRAG-AND-DROP INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  // Layer operations tabs
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
      tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          
          // Switch content
          document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");
          const target = document.getElementById("tab-" + tab.getAttribute("data-tab"));
          if (target) target.style.display = "block";
      });
  });
});
