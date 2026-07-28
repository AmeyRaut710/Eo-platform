/**
 * app.js — EO Platform Frontend (Vista Mode Redesign)
 *
 * Responsibilities:
 *  - Initialize Leaflet map centered on Hyderabad
 *  - Automatically scan and load all Vista layers on startup
 *  - Handle global band arithmetic and index formulas
 *  - Center and display metadata for selected images
 *  - Nominatim geocoding search
 *  - Status polling
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_URL  = "http://localhost:8000";
const TITILER_URL  = "http://localhost:8001";
const HYDERABAD    = [17.3850, 78.4867];
const DEFAULT_ZOOM = 10;
const POLL_MS      = 4000;  // status poll interval

// ── State ─────────────────────────────────────────────────────────────────────
let map;
let vistaLayers = [];
let vistaImages = [];
let vistaBaseMap = null;
let currentQueryParams = ""; // Stores global band arithmetic URL parameters

let isDownloadMode = false;
let imagesToDownload = 0;
let selectedDownloadImages = [];
let footprintLayers = [];

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

  // Scale bar
  L.control.scale({ imperial: false }).addTo(map);

  // Set map background
  const mapElement = document.getElementById("map");
  if (mapElement) {
    mapElement.style.backgroundColor = "#f8f9fa";
  }

  // Events
  map.on("zoom",       updateZoomInfo);
  map.on("mousemove",  updateCoords);
  map.on("click",      onMapClick);
  map.on("zoomend",    updatePyramidLevel);

  updateZoomInfo();
  updatePyramidLevel();
}

// ══════════════════════════════════════════════════════════════════════════════
// VISTA LAYERS LOADING
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// VISTA LAYERS LOADING, FILTERING & SEARCH
// ══════════════════════════════════════════════════════════════════════════════

async function initVista() {
  // Add India GeoJSON base map
  if (!vistaBaseMap && typeof map !== 'undefined') {
    try {
      const geoRes = await fetch("/static/india_states.geojson");
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        vistaBaseMap = L.geoJSON(geoData, {
          style: {
            color: "#9ca3af", // Thin grey lines
            weight: 1,
            fillOpacity: 0 // Transparent
          }
        });
        vistaBaseMap.addTo(map);
      }
    } catch (e) {
      console.error("Failed to load India GeoJSON:", e);
    }
  }

  // Load dynamic filter choices from pgSTAC
  await updateFilterChoices();
  
  // Also poll filter choices periodically every 15 seconds to detect newly scanned imagery
  setInterval(updateFilterChoices, 15000);

  // Submit initial search to load all images on start
  await searchImages();
}

async function updateFilterChoices() {
  try {
    // Read current values to send to backend for cascading filter
    const params = new URLSearchParams();
    const mission = document.getElementById("filterMission")?.value;
    const sensor = document.getElementById("filterSensor")?.value;
    const level = document.getElementById("filterLevel")?.value;
    const type = document.getElementById("filterType")?.value;
    const tile = document.getElementById("filterTile")?.value;
    const resValue = document.getElementById("filterRes")?.value;
    const cloud = document.getElementById("filterCloud")?.value;
    const startDate = document.getElementById("filterDateStart")?.value;
    const endDate = document.getElementById("filterDateEnd")?.value;
    
    if (mission) params.append("mission", mission);
    if (sensor) params.append("sensor", sensor);
    if (level) params.append("processing_level", level);
    if (type) params.append("product_type", type);
    if (tile) params.append("tile_id", tile);
    if (resValue) params.append("resolution", resValue);
    if (cloud) params.append("cloud_cover", cloud);
    if (startDate) params.append("start_date", startDate);
    if (endDate) params.append("end_date", endDate);

    const qs = params.toString();
    const url = `${BACKEND_URL}/vista/filters${qs ? '?' + qs : ''}`;
    
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const filters = await res.json();
    
    // Helper to populate select element
    const populateSelect = (elementId, values, defaultLabel) => {
      const el = document.getElementById(elementId);
      if (!el) return;
      const currentVal = el.value;
      el.innerHTML = `<option value="">${defaultLabel}</option>`;
      values.forEach(val => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = val;
        el.appendChild(opt);
      });
      // Restore selected value if it's still available in the new list
      if (values.includes(currentVal)) {
        el.value = currentVal;
      }
    };
    
    populateSelect("filterMission", filters.mission || [], "All Missions");
    populateSelect("filterSensor", filters.sensor || [], "All Sensors");
    populateSelect("filterLevel", filters.processing_level || [], "All Levels");
    populateSelect("filterType", filters.product_type || [], "All Types");
    populateSelect("filterTile", filters.tile_id || [], "All Tiles");
    populateSelect("filterRes", filters.resolution || [], "All Resolutions");
  } catch (e) {
    console.error("Error updating filter choices:", e);
  }
}

async function searchImages() {
  showToast("Searching catalog...", "info");
  
  const loading = document.getElementById("loadingOverlay");
  if (loading) loading.classList.remove("hidden");
  
  try {
    // Clear existing Leaflet layers
    vistaLayers.forEach(layer => map.removeLayer(layer));
    vistaLayers = [];
    vistaImages = [];
    
    // Read search inputs
    const mission = document.getElementById("filterMission").value;
    const sensor = document.getElementById("filterSensor").value;
    const level = document.getElementById("filterLevel").value;
    const type = document.getElementById("filterType").value;
    const tile = document.getElementById("filterTile").value;
    const resValue = document.getElementById("filterRes").value;
    const cloud = document.getElementById("filterCloud").value;
    const startDate = document.getElementById("filterDateStart")?.value;
    const endDate = document.getElementById("filterDateEnd")?.value;
    
    // Build query params
    const params = new URLSearchParams();
    if (mission) params.append("mission", mission);
    if (sensor) params.append("sensor", sensor);
    if (level) params.append("processing_level", level);
    if (type) params.append("product_type", type);
    if (tile) params.append("tile_id", tile);
    if (resValue) params.append("resolution", resValue);
    if (cloud) params.append("cloud_cover", cloud);
    if (startDate) params.append("start_date", startDate);
    if (endDate) params.append("end_date", endDate);
    
    const searchUrl = `${BACKEND_URL}/vista/search?${params.toString()}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error("Search failed");
    
    const items = await searchRes.json();
    const reversedItems = [...items].reverse(); // Lowest cloud cover processed last to lay on top
    
    let firstBounds = null;
    
    for (const item of reversedItems) {
      // Generate tile URL directly to avoid N network requests and make rendering instantaneous
      let finalTileUrl = item.tile_url;
      if (currentQueryParams) {
        finalTileUrl += currentQueryParams.replace("?", "&");
      } else {
        finalTileUrl += item.default_assets || "";
      }
      
      const layer = L.tileLayer(finalTileUrl, {
        minZoom: 2,
        maxZoom: 24,
        minNativeZoom: 1,
        maxNativeZoom: 24,
        attribution: `Vista - ${item.name}`,
        opacity: 1,
        tileSize: 256,
        keepBuffer: 4,
      });
      
      layer.addTo(map);
      vistaLayers.push(layer);
      
      vistaImages.push({
        name: item.name,
        date: item.metadata.acquisition_date,
        cloud: item.metadata.cloud_cover,
        res: item.metadata.resolution,
        layer: layer,
        base_tile_url: item.tile_url,
        default_assets: item.default_assets,
        assets: item.assets,
        bbox: item.bbox,
        stac_url: item.links?.find(l => l.rel==="self")?.href || `http://localhost:8000/vista/stac/${item.name}`
      });
      
      if (item.bbox) {
        firstBounds = item.bbox;
      }
    }
    
    populateLayersList();
    
    if (firstBounds) {
      const [w, s, e, n] = firstBounds;
      map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    }
    
    // Auto-select the top-most image (the one rendered last) to populate the band palette
    if (vistaImages.length > 0) {
      const topImage = vistaImages[vistaImages.length - 1];
      const allCards = document.querySelectorAll(".dataset-card");
      if (allCards.length > 0) {
        selectVistaImage(topImage, allCards[0]);
      } else {
        selectVistaImage(topImage, null);
      }
    }
    
    map.invalidateSize();
    setTimeout(() => map.invalidateSize(), 200);
    setTimeout(() => map.invalidateSize(), 500);
    
    if (loading) loading.classList.add("hidden");
    showToast(`Search completed. Found ${items.length} images.`, "success");
  } catch (e) {
    console.error("Search error:", e);
    showToast("Error searching catalog", "error");
    if (loading) loading.classList.add("hidden");
  }
}

function populateLayersList() {
  const vistaLayerList = document.getElementById("vistaLayerList");
  if (!vistaLayerList) return;
  
  if (vistaImages.length === 0) {
    vistaLayerList.innerHTML = '<div class="status-msg">No images match query</div>';
    return;
  }
  
  vistaLayerList.innerHTML = "";
  const sortedImages = [...vistaImages].reverse();
  
  sortedImages.forEach((imgObj, idx) => {
    const div = document.createElement("div");
    div.className = "dataset-card";
    div.style.marginBottom = "10px";
    div.style.padding = "8px";
    div.style.cursor = "pointer";
    
    const dateStr = imgObj.date ? imgObj.date.split("T")[0] : "—";
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <strong class="dataset-card__name" style="font-size:12px; color:var(--text-light); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:180px;">${imgObj.name}</strong>
        <button class="icon-btn toggle-vis" data-idx="${idx}" style="cursor:pointer; background:none; border:none; color:var(--text); opacity:1; padding:2px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>
      <div style="font-size:10px; color:var(--text-dim); line-height:1.4;">
        Date: ${dateStr} · Cloud: ${imgObj.cloud.toFixed(1)}% · Res: ${imgObj.res}
      </div>
    `;
    
    const eyeBtn = div.querySelector('.toggle-vis');
    eyeBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      const isVisible = map.hasLayer(imgObj.layer);
      if (isVisible) {
        map.removeLayer(imgObj.layer);
        this.style.opacity = "0.3";
      } else {
        imgObj.layer.addTo(map);
        this.style.opacity = "1";
      }
    });
    
    div.addEventListener("click", () => selectVistaImage(imgObj, div));
    
    vistaLayerList.appendChild(div);
  });
}

async function selectVistaImage(imgObj, element) {
  document.querySelectorAll(".dataset-card").forEach(el => el.classList.remove("active"));
  if (element) element.classList.add("active");
  
  const metaCard = document.getElementById("cardMeta");
  if (metaCard) metaCard.style.display = "block";
  
  const palette = document.getElementById("bandPalette");
  if (palette) {
    palette.innerHTML = "";
    const colorMap = {
      'band01': 'bg-purple', 'band1': 'bg-purple',
      'band02': 'bg-blue',   'band2': 'bg-blue',
      'band03': 'bg-green',  'band3': 'bg-green',
      'band04': 'bg-orange', 'band4': 'bg-orange',
      'band05': 'bg-red',    'band5': 'bg-red',
      'band06': 'bg-dark-orange', 'band6': 'bg-dark-orange',
      'band07': 'bg-dark-red',    'band7': 'bg-dark-red',
      'band08': 'bg-red',    'band8': 'bg-red',
      'band8A': 'bg-deep-red',
      'band09': 'bg-brick-red', 'band9': 'bg-brick-red',
      'band10': 'bg-violet', 'band11': 'bg-violet', 'band12': 'bg-brown'
    };
    if (imgObj.assets) {
      Object.keys(imgObj.assets).forEach(key => {
         if (key.toUpperCase() === "TCI") return;
         const item = document.createElement("div");
         const bgClass = colorMap[key] || "bg-blue";
         item.className = `band-item ${bgClass}`;
         item.draggable = true;
         item.textContent = key.toUpperCase().replace("BAND0", "B0").replace("BAND", "B");
         
         item.addEventListener("dragstart", (e) => {
           window.draggedItem = e.target;
           e.dataTransfer.setData("text/plain", e.target.textContent);
           setTimeout(() => e.target.style.opacity = '0.5', 0);
         });
         item.addEventListener("dragend", (e) => {
           setTimeout(() => e.target.style.opacity = '1', 0);
           window.draggedItem = null;
         });
         
         palette.appendChild(item);
      });
    }
  }
  
  try {
    const res = await fetch(`${BACKEND_URL}/vista/info/${imgObj.name}`);
    if (!res.ok) return;
    const info = await res.json();
    
    setText("metaWidth",   info.resolution ?? "—");
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
  } catch (e) {
    console.error("Error loading Vista metadata:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL BAND ARITHMETIC APPLICATION
// ══════════════════════════════════════════════════════════════════════════════

async function applyVisualization() {
  const loading = document.getElementById("loadingOverlay");
  if (loading) loading.classList.remove("hidden");
  
  try {
    const activeTab = document.querySelector(".tab.active").getAttribute("data-tab");
    let queryParams = "";
    
    if (activeTab === "composite") {
      const r = document.getElementById("drop-r").textContent.trim() || "B04";
      const g = document.getElementById("drop-g").textContent.trim() || "B03";
      const b = document.getElementById("drop-b").textContent.trim() || "B02";
      if (r === "B04" && g === "B03" && b === "B02") {
        queryParams = ""; // default TCI
      } else {
        const ar = r.replace("B", "band");
        const ag = g.replace("B", "band");
        const ab = b.replace("B", "band");
        queryParams = `?assets=${ar}&assets=${ag}&assets=${ab}&asset_bidx=${ar}|1&asset_bidx=${ag}|1&asset_bidx=${ab}|1&rescale=0,3000`;
      }
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
        
        const an1 = n1.replace("B", "band");
        const an2 = n2.replace("B", "band");
        const an3 = n3.replace("B", "band");
        const an4 = n4.replace("B", "band");
        
        if (n1 === "B08" && n2 === "B04" && n3 === "B08" && n4 === "B04") {
          expr = encodeURIComponent(`(${an1}-${an2})/(${an1}+${an2})`);
          queryParams = `?expression=${expr}&asset_bidx=${an1}|1&asset_bidx=${an2}|1&colormap_name=rdylgn&rescale=-1,1&asset_as_band=true`;
        } else if (n1 === "B03" && n2 === "B08" && n3 === "B03" && n4 === "B08") {
          expr = encodeURIComponent(`(${an1}-${an2})/(${an1}+${an2})`);
          queryParams = `?expression=${expr}&asset_bidx=${an1}|1&asset_bidx=${an2}|1&colormap_name=rdylgn&rescale=-1,1&asset_as_band=true`;
        } else {
          const uniqueAssets = [...new Set([an1, an2, an3, an4])];
          const bidxQuery = uniqueAssets.map(a => `asset_bidx=${a}|1`).join("&");
          
          expr = encodeURIComponent(`(${an1}-${an2})/(${an3}+${an4})`);
          rescale = "-1,1";
          const cmap = "rdylgn";
          queryParams = `?expression=${expr}&${bidxQuery}&colormap_name=${cmap}&rescale=${rescale}&asset_as_band=true`;
        }
      } else {
        const r1 = document.getElementById("drop-idx-r1").textContent.trim() || "B08";
        const r2 = document.getElementById("drop-idx-r2").textContent.trim() || "B04";
        
        const ar1 = r1.replace("B", "band");
        const ar2 = r2.replace("B", "band");
        
        const uniqueAssets = [...new Set([ar1, ar2])];
        const bidxQuery = uniqueAssets.map(a => `asset_bidx=${a}|1`).join("&");
        
        expr = encodeURIComponent(`(${ar1}/${ar2})`);
        rescale = "0,3";
        const cmap = "rdylgn";
        queryParams = `?expression=${expr}&${bidxQuery}&colormap_name=${cmap}&rescale=${rescale}&asset_as_band=true`;
      }
    } else if (activeTab === "formula") {
      let formulaStr = document.getElementById("formulaInput").value.trim();
      const container = document.getElementById("dynamic-formula-zones");
      
      if (!formulaStr) {
        showToast("Formula is empty!", "error");
        return;
      }
      
      const dropZones = container.querySelectorAll('.dyn-formula-drop');
      if (dropZones.length === 0) {
        showToast("Please confirm formula and assign bands", "error");
        return;
      }

      let uniqueBands = [];
      let allAssigned = true;

      // Substitute variables with assigned band names
      dropZones.forEach(zone => {
        const v = zone.getAttribute('data-var');
        const bandVal = zone.textContent.trim();
        if (bandVal === "Drop" || !bandVal) {
          allAssigned = false;
        } else {
          uniqueBands.push(bandVal);
          // Replace variable in formula with the band name (e.g. B08)
          const regex = new RegExp(`\\b${v}\\b`, 'g');
          formulaStr = formulaStr.replace(regex, bandVal);
        }
      });

      if (!allAssigned) {
        showToast("Please assign bands to all variables", "error");
        return;
      }

      uniqueBands = [...new Set(uniqueBands)];

      // Replace them in the expression string with bandXX for TiTiler
      let exprStr = formulaStr;
      uniqueBands.forEach(b => {
        const assetName = b.replace("B", "band");
        exprStr = exprStr.replace(new RegExp(`\\b${b}\\b`, 'g'), assetName);
      });
      
      const bidxQuery = uniqueBands.map(b => `asset_bidx=${b.replace("B", "band")}|1`).join("&");
      const bidxPart = bidxQuery ? `&${bidxQuery}` : "";
      
      const exprEncoded = encodeURIComponent(exprStr);
      queryParams = `?expression=${exprEncoded}${bidxPart}&colormap_name=rdylgn&rescale=-1,1&asset_as_band=true`;
    }
    
    currentQueryParams = queryParams;
    
    // Update and refresh all layers on the map simultaneously, completely client-side
    vistaImages.forEach((imgObj) => {
      let finalTileUrl = imgObj.base_tile_url;
      if (currentQueryParams) {
        finalTileUrl += currentQueryParams.replace("?", "&");
      } else {
        finalTileUrl += imgObj.default_assets || "";
      }
      imgObj.layer.setUrl(finalTileUrl);
    });
    
    showToast("Virtual Mosaic visualization updated!", "success");
  } catch (e) {
    console.error("Error applying visualization:", e);
    showToast("Error updating Virtual Mosaic", "error");
  } finally {
    if (loading) loading.classList.add("hidden");
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

    const bar = document.getElementById("progressBar");
    if (data.progress > 0 && data.progress < 100) {
      bar.classList.add("loading");
      bar.style.width = data.progress + "%";
    } else {
      bar.classList.remove("loading");
      bar.style.width = (data.progress || 0) + "%";
    }
    document.getElementById("statusMsg").textContent = data.message || "—";

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

let vistaBannerTimeout = null;

async function pollVistaStatus() {
  try {
    const res = await fetch(`${BACKEND_URL}/vista/status`);
    if (!res.ok) return;
    const data = await res.json();
    
    const banner = document.getElementById("vistaStatusBanner");
    const spinner = document.getElementById("vistaSpinner");
    const text = document.getElementById("vistaStatusText");
    
    if (data.converting) {
      banner.style.display = "flex";
      spinner.style.display = "inline-block";
      text.textContent = data.message || "Image is converting wait...";
      banner.style.border = "1px solid #00e5ff";
      
      const bar = document.getElementById("progressBar");
      if (data.progress > 0 && data.progress < 100) {
        bar.classList.add("loading");
        bar.style.width = data.progress + "%";
      } else {
        bar.classList.remove("loading");
        bar.style.width = (data.progress || 0) + "%";
      }
      
      if (vistaBannerTimeout) {
        clearTimeout(vistaBannerTimeout);
        vistaBannerTimeout = null;
      }
    } else {
      if (data.message === "Conversion is over" && banner.style.display === "flex") {
        spinner.style.display = "none";
        text.textContent = data.message;
        banner.style.border = "1px solid #00ffaa";
        
        // Hide after 5 seconds
        if (!vistaBannerTimeout) {
          vistaBannerTimeout = setTimeout(() => {
            banner.style.display = "none";
          }, 5000);
        }
      } else if (data.message === "Idle") {
        banner.style.display = "none";
      }
    }
  } catch (e) {
    // silently ignore errors
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

    // Drop marker
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

// Toast notification
let toastTimer;
function showToast(msg, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════

(async function boot() {
  initMap();

  // Initial checks and scan vista images
  await Promise.all([pollStatus(), checkTiTiler(), pollVistaStatus(), initVista()]);

  // Start polling
  setInterval(pollStatus,    POLL_MS);
  setInterval(checkTiTiler,  POLL_MS * 2);
  setInterval(pollVistaStatus, POLL_MS);

  showToast("EO Platform Ready (Vista Mode)", "info");
})();

// ══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING & DRAG-AND-DROP INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  // Layer operations tabs
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        t.classList.remove('active');
        t.style.color = "#555";
        t.style.border = "1px solid #222";
        t.style.background = "transparent";
      });
      tab.classList.add('active');
      tab.style.color = "#00e5ff";
      tab.style.border = "1px solid #00e5ff";
      tab.style.background = "rgba(0, 229, 255, 0.05)";
      
      // Switch content
      document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");
      const target = document.getElementById("tab-" + tab.getAttribute("data-tab"));
      if (target) target.style.display = "block";
    });
  });

  // Drag and Drop Logic
  window.draggedItem = null;

  // For any static items (if they existed)
  document.querySelectorAll(".band-item").forEach(item => {
    item.addEventListener("dragstart", (e) => {
      window.draggedItem = e.target;
      e.dataTransfer.setData("text/plain", e.target.textContent);
      setTimeout(() => e.target.style.opacity = '0.5', 0);
    });
    
    item.addEventListener("dragend", (e) => {
      setTimeout(() => e.target.style.opacity = '1', 0);
      window.draggedItem = null;
    });
  });

  document.querySelectorAll(".band-drop-zone").forEach(zone => {
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
      if (window.draggedItem) {
        zone.textContent = window.draggedItem.textContent;
        const bgClass = Array.from(window.draggedItem.classList).find(c => c.startsWith('bg-'));
        
        const selPreset = document.getElementById("selCompositePreset");
        if (selPreset && (zone.id === "drop-r" || zone.id === "drop-g" || zone.id === "drop-b")) {
          selPreset.value = "custom";
        }
        
        const selIdxPreset = document.getElementById("selIndexPreset");
        if (selIdxPreset && zone.id.startsWith("drop-idx-")) {
          selIdxPreset.value = "custom";
        }
        
        Array.from(zone.classList).forEach(c => {
          if (c.startsWith('bg-')) zone.classList.remove(c);
        });
        
        if (bgClass) {
          zone.classList.add(bgClass);
          zone.classList.add('filled');
        }
        
        // Auto-update corresponding denominator bands for normalized index
        if (zone.id === "drop-idx-n1") {
          const n3 = document.getElementById("drop-idx-n3");
          if (n3) {
            n3.textContent = window.draggedItem.textContent;
            Array.from(n3.classList).forEach(c => { if (c.startsWith('bg-')) n3.classList.remove(c); });
            if (bgClass) { n3.classList.add(bgClass); n3.classList.add('filled'); }
          }
        } else if (zone.id === "drop-idx-n2") {
          const n4 = document.getElementById("drop-idx-n4");
          if (n4) {
            n4.textContent = window.draggedItem.textContent;
            Array.from(n4.classList).forEach(c => { if (c.startsWith('bg-')) n4.classList.remove(c); });
            if (bgClass) { n4.classList.add(bgClass); n4.classList.add('filled'); }
          }
        }
      }
    });
  });

  const btnConfirmFormula = document.getElementById("btnConfirmFormula");
  if (btnConfirmFormula) {
    btnConfirmFormula.addEventListener("click", () => {
      const expr = document.getElementById("formulaInput").value.trim();
      const container = document.getElementById("dynamic-formula-zones");
      
      if (!expr) {
        container.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:11px; margin: 10px 0;">Enter an expression and click Confirm to assign bands.</div>';
        return;
      }

      // Find all unique alphabetic variables (A-Z, a-z)
      const varRegex = /[a-zA-Z]+/g;
      const foundVars = expr.match(varRegex) || [];
      
      // Filter out math functions if user types them (sqrt, log, max, min, sin, cos, tan, exp, pow, abs)
      const mathFuncs = ['sqrt', 'log', 'max', 'min', 'sin', 'cos', 'tan', 'exp', 'pow', 'abs'];
      const uniqueVars = [...new Set(foundVars)].filter(v => !mathFuncs.includes(v.toLowerCase()));

      if (uniqueVars.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:11px; margin: 10px 0;">No variables found in expression.</div>';
        return;
      }

      let html = '<div style="display:flex; justify-content:center; gap:12px; align-items:center; background:rgba(18, 25, 48, 0.4); border:1px solid rgba(0, 242, 254, 0.2); border-radius:8px; padding:12px 10px; flex-wrap:wrap;">';
      
      uniqueVars.forEach(v => {
        html += `
          <div class="rgb-input-group">
            <label>${v}:</label>
            <div class="band-drop-zone dyn-formula-drop" id="drop-dyn-${v}" data-var="${v}">Drop</div>
          </div>
        `;
      });
      html += '</div>';
      
      container.innerHTML = html;

      // Rebind drag and drop for new drop zones
      document.querySelectorAll(".dyn-formula-drop").forEach(zone => {
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
          if (window.draggedItem) {
            zone.textContent = window.draggedItem.textContent;
            const bgClass = Array.from(window.draggedItem.classList).find(c => c.startsWith('bg-'));
            Array.from(zone.classList).forEach(c => {
              if (c.startsWith('bg-')) zone.classList.remove(c);
            });
            if (bgClass) {
              zone.classList.add(bgClass);
              zone.classList.add('filled');
            }
          }
        });
      });
    });
  }

  // Search Form Submit
  const btnSearchSubmit = document.getElementById("btnSearchSubmit");
  if (btnSearchSubmit) {
    btnSearchSubmit.addEventListener("click", (e) => {
      e.preventDefault();
      searchImages();
    });
  }

  // Cascading Dropdown Listeners
  const filterIds = ["filterMission", "filterSensor", "filterLevel", "filterType", "filterTile", "filterRes", "filterCloud", "filterDateStart", "filterDateEnd"];
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", updateFilterChoices);
    }
  });

  // Apply buttons listeners
  document.getElementById("btnApplyComposite").addEventListener("click", applyVisualization);
  document.getElementById("btnApplyIndex").addEventListener("click", applyVisualization);
  document.getElementById("btnApplyFormula").addEventListener("click", applyVisualization);

  const bandColors = {
    'B01': 'bg-purple',
    'B02': 'bg-blue',
    'B03': 'bg-green',
    'B04': 'bg-orange',
    'B05': 'bg-red',
    'B06': 'bg-dark-orange',
    'B07': 'bg-dark-red',
    'B08': 'bg-red',
    'B8A': 'bg-deep-red',
    'B09': 'bg-brick-red',
    'B11': 'bg-violet',
    'B12': 'bg-brown'
  };

  function updateZoneWithColor(zoneId, bandName) {
    const zone = document.getElementById(zoneId);
    if (!zone) return;
    zone.textContent = bandName;
    Array.from(zone.classList).forEach(c => { if (c.startsWith('bg-')) zone.classList.remove(c); });
    const bgClass = bandColors[bandName];
    if (bgClass) {
      zone.classList.add(bgClass);
      zone.classList.add('filled');
    }
  }

  const selCompositePreset = document.getElementById("selCompositePreset");
  if (selCompositePreset) {
    selCompositePreset.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") return;
      
      const bands = val.split(",");
      if (bands.length === 3) {
        updateZoneWithColor("drop-r", bands[0]);
        updateZoneWithColor("drop-g", bands[1]);
        updateZoneWithColor("drop-b", bands[2]);
        applyVisualization();
      }
    });
  }

  const selIndexPreset = document.getElementById("selIndexPreset");
  if (selIndexPreset) {
    selIndexPreset.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") return;
      
      const parts = val.split(",");
      if (parts.length === 3) {
        const format = parts[0];
        const bandA = parts[1];
        const bandB = parts[2];
        
        const selFormat = document.getElementById("selIndexFormat");
        if (selFormat) {
          selFormat.value = format;
          selFormat.dispatchEvent(new Event("change"));
        }
        
        if (format === "normalized") {
          updateZoneWithColor("drop-idx-n1", bandA);
          updateZoneWithColor("drop-idx-n3", bandA);
          
          updateZoneWithColor("drop-idx-n2", bandB);
          updateZoneWithColor("drop-idx-n4", bandB);
          
          if (document.getElementById("formulaInput")) {
            document.getElementById("formulaInput").value = `(${bandA}-${bandB})/(${bandA}+${bandB})`;
          }
        } else if (format === "ratio") {
          updateZoneWithColor("drop-idx-r1", bandA);
          updateZoneWithColor("drop-idx-r2", bandB);
          
          if (document.getElementById("formulaInput")) {
            document.getElementById("formulaInput").value = `${bandA}/${bandB}`;
          }
        }
        
        applyVisualization();
      }
    });
  }

  document.getElementById("selIndexFormat").addEventListener("change", (e) => {
    if (e.target.value === "normalized") {
      document.getElementById("formula-normalized").style.display = "flex";
      document.getElementById("formula-ratio").style.display = "none";
    } else {
      document.getElementById("formula-normalized").style.display = "none";
      document.getElementById("formula-ratio").style.display = "flex";
    }
  });

  
  // ─── DOWNLOAD WORKFLOW LOGIC ────────────────────────────────────────────────
  const btnMapDownload = document.getElementById("btnMapDownload");
  const modalCount = document.getElementById("modalDownloadCount");
  const inputCount = document.getElementById("inputDownloadCount");
  const btnCancelCount = document.getElementById("btnCancelCount");
  const btnConfirmCount = document.getElementById("btnConfirmCount");
  
  const modalConfirm = document.getElementById("modalDownloadConfirm");
  const previewContainer = document.getElementById("downloadPreviewContainer");
  const btnCancelConfirm = document.getElementById("btnCancelConfirm");
  const btnExecuteDownload = document.getElementById("btnExecuteDownload");

  function exitDownloadMode() {
    isDownloadMode = false;
    imagesToDownload = 0;
    selectedDownloadImages = [];
    if(footprintLayers) footprintLayers.forEach(l => map.removeLayer(l.rect));
    footprintLayers = [];
    modalCount.classList.add("hidden");
    modalConfirm.classList.add("hidden");
  }

  if (btnMapDownload) {
    btnMapDownload.addEventListener("click", () => {
      if (vistaImages.length === 0) {
        showToast("No images currently loaded.", "error");
        return;
      }
      modalCount.classList.remove("hidden");
      inputCount.value = 1;
      inputCount.max = vistaImages.length;
    });
  }

  if (btnCancelCount) btnCancelCount.addEventListener("click", exitDownloadMode);
  if (btnCancelConfirm) btnCancelConfirm.addEventListener("click", exitDownloadMode);

  if (btnConfirmCount) {
    btnConfirmCount.addEventListener("click", () => {
      imagesToDownload = parseInt(inputCount.value);
      if (isNaN(imagesToDownload) || imagesToDownload < 1) {
         imagesToDownload = 1;
      }
      if (imagesToDownload > vistaImages.length) {
         imagesToDownload = vistaImages.length;
      }
      
      modalCount.classList.add("hidden");
      isDownloadMode = true;
      selectedDownloadImages = [];
      showToast(`Select ${imagesToDownload} images by clicking their yellow borders.`, "info");
      
      if(footprintLayers) footprintLayers.forEach(l => map.removeLayer(l.rect));
      footprintLayers = [];
      
      vistaImages.forEach((img) => {
        if (!img.bbox) return;
        const [w, s, e, n] = img.bbox;
        const rect = L.rectangle([[s, w], [n, e]], {
          color: "#ffcc00",
          weight: 2,
          fillColor: "#ffcc00",
          fillOpacity: 0.1,
          dashArray: "5, 5"
        }).addTo(map);
        
        rect.on('click', () => {
          if (!isDownloadMode) return;
          const idx = selectedDownloadImages.indexOf(img);
          if (idx > -1) {
            // Deselect
            selectedDownloadImages.splice(idx, 1);
            rect.setStyle({ color: "#ffcc00", fillOpacity: 0.1, dashArray: "5, 5" });
          } else {
            // Select
            if (selectedDownloadImages.length >= imagesToDownload) return;
            selectedDownloadImages.push(img);
            rect.setStyle({ color: "#00e5ff", fillOpacity: 0.3, dashArray: "" });
            
            if (selectedDownloadImages.length === imagesToDownload) {
               showConfirmModal();
            }
          }
        });
        
        footprintLayers.push({ img, rect });
      });
    });
  }
  
  function showConfirmModal() {
    previewContainer.innerHTML = "";
    selectedDownloadImages.forEach(img => {
      // Build preview URL
      const stacUrl = img.stac_url;
      let q = currentQueryParams;
      if (!q) {
        q = "?asset_bidx=TCI|1,TCI|2,TCI|3&asset_as_band=true";
      }
      const previewUrl = `http://localhost:8001/stac/preview.png${q}&url=${encodeURIComponent(stacUrl)}&max_size=256`;
      
      const div = document.createElement("div");
      div.style.cssText = "display:flex; flex-direction:column; align-items:center; background:#1e253c; padding:5px; border-radius:4px; border:1px solid #333;";
      
      const imgEl = document.createElement("img");
      imgEl.src = previewUrl;
      imgEl.style.cssText = "width:100px; height:100px; object-fit:cover; margin-bottom:5px; border-radius:2px;";
      
      const label = document.createElement("span");
      label.style.cssText = "font-size:10px; color:#fff;";
      label.textContent = img.name;
      
      div.appendChild(imgEl);
      div.appendChild(label);
      previewContainer.appendChild(div);
    });
    
    modalConfirm.classList.remove("hidden");
  }
  
  if (btnExecuteDownload) {
    btnExecuteDownload.addEventListener("click", async () => {
      showToast("Preparing downloads...", "info");
      btnExecuteDownload.disabled = true;
      btnExecuteDownload.textContent = "Downloading...";
      
      const zip = new JSZip();
      const folder = zip.folder("DRISHTI");
      let successCount = 0;

      for (const img of selectedDownloadImages) {
        const stacUrl = img.stac_url;
        let q = currentQueryParams;
        if (!q) {
          q = "?asset_bidx=TCI|1,TCI|2,TCI|3&asset_as_band=true";
        }
        
        const downloadUrl = `http://localhost:8001/stac/preview.png${q}&url=${encodeURIComponent(stacUrl)}`;
        
        try {
          const res = await fetch(downloadUrl);
          if (!res.ok) throw new Error("Failed to fetch image");
          const blob = await res.blob();
          
          folder.file(`DRISHTI_${img.name}.png`, blob);
          successCount++;
        } catch (e) {
          console.error(e);
          showToast(`Failed to fetch ${img.name}`, "error");
        }
      }
      
      if (successCount > 0) {
        showToast("Generating ZIP folder...", "info");
        const zipBlob = await zip.generateAsync({type:"blob"});
        const objUrl = URL.createObjectURL(zipBlob);
        
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = "DRISHTI.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      }
      
      btnExecuteDownload.disabled = false;
      btnExecuteDownload.textContent = "Download";
      exitDownloadMode();
      showToast("Download complete!", "success");
    });
  }
  // Search listeners
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
  
  if (searchBtn && searchInput) {
    searchBtn.addEventListener("click", () => searchLocation(searchInput.value));
    searchInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        searchLocation(searchInput.value);
      }
    });
  }
});
