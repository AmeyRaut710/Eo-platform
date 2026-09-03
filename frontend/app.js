/**
 * app.js â EO Platform Frontend (Vista Mode Redesign)
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

// ââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const BACKEND_URL  = "http://localhost:8000";
const TITILER_URL  = "http://localhost:8001";
const INDIA    = [20.5937, 78.9629];
const DEFAULT_ZOOM = 5;
const POLL_MS      = 4000;  // status poll interval

// ââ State âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let map;
let vistaLayers = [];
let vistaImages = [];
let vistaBaseMap = null;
let currentQueryParams = ""; // Stores global band arithmetic URL parameters

let isDownloadMode = false;
let imagesToDownload = 0;
let selectedDownloadImages = [];
let footprintLayers = [];

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// MAP INITIALISATION
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function initMap() {
  map = L.map("map", {
    center: INDIA,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    attributionControl: false,
    minZoom: 2,
    maxZoom: 24
  });

  // Base Maps (Bhuvan WMS & Esri)
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri'
  });

  const bhuvanBaseAdmin = L.tileLayer.wms('https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wms', {
    layers: 'india3', 
    format: 'image/jpeg',
    transparent: false,
    version: '1.1.1',
    attribution: 'NRSC/ISRO Bhuvan'
  });

  // Default to Satellite
  satellite.addTo(map);

  // Overlay Maps (Bhuvan WMS)
  const bhuvanAdmin = L.tileLayer.wms('https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wms', {
    layers: 'bhuvan_no_data', // Generic placeholder for actual Bhuvan admin layer
    format: 'image/png',
    transparent: true,
    version: '1.1.1',
    attribution: 'NRSC/ISRO Bhuvan',
    zIndex: 200
  });

  const infrastructure = L.tileLayer.wms('https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wms', {
    layers: 'bhuvan_no_data', 
    format: 'image/png',
    transparent: true,
    version: '1.1.1',
    attribution: 'NRSC/ISRO Bhuvan',
    zIndex: 200
  });

  // Layer Control
  const baseMaps = {
    "Satellite": satellite,
    "Base Admin": bhuvanBaseAdmin
  };
  const overlayMaps = {
    "Admin Boundary": bhuvanAdmin,
    "Infrastructure": infrastructure
  };
  
  L.control.layers(baseMaps, overlayMaps, { position: 'topright', collapsed: true }).addTo(map);



  // Scale bar
  L.control.scale({ imperial: false }).addTo(map);

  // Set map background
  const mapElement = document.getElementById("map");
  if (mapElement) {
    mapElement.style.backgroundColor = "#f8f9fa";
  }

  // Events
  map.on("zoom",       updateZoomInfo);
  map.on("zoom",       updateZoomHUD);
  map.on("mousemove",  updateCoords);
  map.on("click",      onMapClick);

  // Trigger initial HUD update
  updateZoomHUD();
  
  map.on("zoomend",    updatePyramidLevel);
  updatePyramidLevel();
}

function decimalToDMS(deg) {
  const d = Math.floor(deg);
  const minfloat = (deg - d) * 60;
  const m = Math.floor(minfloat);
  const secfloat = (minfloat - m) * 60;
  const s = Math.round(secfloat);
  return `${d}° ${m}' ${s}"`;
}

function updateCoords(e) {
  const hud = document.getElementById("coords-hud");
  if (hud) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    
    const latDec = Math.abs(lat).toFixed(4);
    const lngDec = Math.abs(lng).toFixed(4);
    
    const latDMS = decimalToDMS(Math.abs(lat)) + latDir;
    const lngDMS = decimalToDMS(Math.abs(lng)) + lngDir;
    
    hud.innerText = `Lat: ${latDec}° (${latDMS}) | Lon: ${lngDec}° (${lngDMS}) | Zoom: ${map.getZoom()}`;
  }
}

function updateZoomHUD() {
  const hud = document.getElementById("coords-hud");
  if (hud && hud.innerText.includes('Zoom')) {
    hud.innerText = hud.innerText.replace(/Zoom: \d+/, `Zoom: ${map.getZoom()}`);
  } else if (hud) {
    hud.innerText = `Lat: -- | Lon: -- | Zoom: ${map.getZoom()}`;
  }
}


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// VISTA LAYERS LOADING
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// VISTA LAYERS LOADING, FILTERING & SEARCH
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function initVista() {
  // Add India GeoJSON base map
  if (!vistaBaseMap && typeof map !== 'undefined') {
    try {
      const geoRes = await fetch("/static/india_states_simplified.geojson");
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

  // Images will load only when user clicks Search
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
    // Hide layer operations and metadata until search is successful
    const opsCard = document.getElementById("layerOpsCard");
    const metaCard = document.getElementById("cardMeta");
    if (opsCard) opsCard.style.display = "none";
    if (metaCard) metaCard.style.display = "none";

    // Clear existing Leaflet layers
    vistaLayers.forEach(layer => map.removeLayer(layer));
    vistaLayers = [];
    vistaImages = [];
    
    // Hide timeline if it was open
    const tlContainer = document.getElementById("timelineContainer");
    if (tlContainer) {
      tlContainer.style.display = "none";
      if (window.timelinePlaybackInterval) {
        clearInterval(window.timelinePlaybackInterval);
      }
      if (window.timelineHighlightLayer) {
        map.removeLayer(window.timelineHighlightLayer);
        window.timelineHighlightLayer = null;
      }
    }
    
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
      finalTileUrl += "&nodata=0";
      
      let maxNatZoom = 14;
      if (item.metadata && item.metadata.resolution === "30m") {
        maxNatZoom = 13;
      }
      
      const layer = L.tileLayer(finalTileUrl, {
        minZoom: 2,
        maxZoom: 24,
        minNativeZoom: 1,
        maxNativeZoom: maxNatZoom,
        attribution: `Vista - ${item.name}`,
        opacity: 1,
        tileSize: 256,
        keepBuffer: 4,
        zIndex: 100,
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
        stac_url: item.links?.find(l => l.rel==="self")?.href || `http://localhost:8000/vista/stac/${item.name}`,
        metadata: item.metadata
      });
      
      if (item.bbox) {
        firstBounds = item.bbox;
      }
    }
    
    populateLayersList();
    
    const activeLayersCard = document.getElementById("cardActiveLayers");
    if (activeLayersCard) {
      activeLayersCard.style.display = vistaImages.length > 0 ? "block" : "none";
    }
    
    if (vistaImages.length > 0) {
      selectVistaImage(vistaImages[0]);
    }
    
    if (firstBounds) {
      const [w, s, e, n] = firstBounds;
      map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
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
    
    const dateStr = imgObj.date ? imgObj.date.split("T")[0] : "â";
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
        Date: ${dateStr} Â· Cloud: ${imgObj.cloud.toFixed(1)}% Â· Res: ${imgObj.res}
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
    
    div.addEventListener("click", () => {
      selectVistaImage(imgObj, div);
    });
    
    vistaLayerList.appendChild(div);
  });
}

async function selectVistaImage(imgObj, element) {
  window.currentImageObj = imgObj;
  document.querySelectorAll(".dataset-card").forEach(el => el.classList.remove("active"));
  if (element) element.classList.add("active");
  
  const metaCard = document.getElementById("cardMeta");
  if (metaCard) metaCard.style.display = "block";
  
  const opsCard = document.getElementById("layerOpsCard");
  if (opsCard) opsCard.style.display = "block";
  
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
         
         item.addEventListener("click", (e) => {
           const activeTab = document.getElementById("layerOperationSelect")?.value;
           if (activeTab === "custom" && window.customScriptEditor) {
             const pos = window.customScriptEditor.getPosition();
             window.customScriptEditor.executeEdits("", [{
                range: new window.monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
                text: `sample.${e.target.textContent}`,
                forceMoveMarkers: true
             }]);
             window.customScriptEditor.focus();
           }
         });
         
         palette.appendChild(item);
      });
      
      // Auto-update default composite zones for the selected satellite
      const bKeys = Object.keys(imgObj.assets);
      const bNorms = bKeys.map(k => k.replace(/^band0?/, "").toLowerCase());
      const formatBand = (k) => k.toUpperCase().replace("BAND0", "B0").replace("BAND", "B");
      
      const setZone = (id, k) => {
        const z = document.getElementById(id);
        if (z) z.textContent = formatBand(k);
      };
      
      if (bNorms.includes("4") && bNorms.includes("3") && bNorms.includes("2")) {
        setZone("drop-r", bKeys[bNorms.indexOf("4")]);
        setZone("drop-g", bKeys[bNorms.indexOf("3")]);
        setZone("drop-b", bKeys[bNorms.indexOf("2")]);
      } else if (bKeys.length >= 3) {
        setZone("drop-r", bKeys[0]);
        setZone("drop-g", bKeys[1]);
        setZone("drop-b", bKeys[2]);
      }
      
      // Also update NDVI indices if available (usually NIR=B8/B5, RED=B4)
      if (bNorms.includes("4") && (bNorms.includes("8") || bNorms.includes("5"))) {
        const nirK = bNorms.includes("8") ? bKeys[bNorms.indexOf("8")] : bKeys[bNorms.indexOf("5")];
        const redK = bKeys[bNorms.indexOf("4")];
        setZone("drop-idx-n1", nirK);
        setZone("drop-idx-n2", redK);
        setZone("drop-idx-n3", nirK);
        setZone("drop-idx-n4", redK);
        setZone("drop-idx-r1", nirK);
        setZone("drop-idx-r2", redK);
      }
    }
  }
  
  try {
    const res = await fetch(`${BACKEND_URL}/vista/info/${imgObj.name}`);
    if (!res.ok) return;
    const info = await res.json();
    
    setText("metaWidth",   info.resolution ?? "â€”");
    setText("metaHeight",  info.original_name ?? "â€”");
    setText("metaBands",   info.bands ?? "â€”");
    setText("metaCRS",     info.cog_path ?? "â€”");
    setText("metaSize",    info.file ?? "â€”");
    setText("metaOvr",     info.created_at ?? "â€”");
    setText("metaCenter",
      info.center
        ? `${info.center.lat.toFixed(4)}Â°, ${info.center.lon.toFixed(4)}Â°`
        : "â€”"
    );
    
    if (info.center) {
      map.setView([info.center.lat, info.center.lon], DEFAULT_ZOOM);
    }
  } catch (e) {
    console.error("Error loading Vista metadata:", e);
  }
}

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// GLOBAL BAND ARITHMETIC APPLICATION
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

function resolveBand(bName) {
  if (!bName) return "";
  
  let mission = "";
  if (window.currentImageObj && window.currentImageObj.metadata) {
    mission = window.currentImageObj.metadata.mission || "";
  }

  // Sentinel-2 band designations to other missions' band mappings
  if (mission === "Landsat") {
    const landsatMap = {
      "B01": "band1", // Coastal Aerosol
      "B02": "band2", // Blue
      "B03": "band3", // Green
      "B04": "band4", // Red
      "B05": "band5", // NIR (closest spectral approximation)
      "B06": "band5",
      "B07": "band5",
      "B08": "band5", // NIR
      "B8A": "band5", // Narrow NIR
      "B09": "band9", // Cirrus
      "B10": "band9", // Cirrus
      "B11": "band6", // SWIR 1
      "B12": "band7", // SWIR 2
      "B1": "band1", "B2": "band2", "B3": "band3", "B4": "band4", "B5": "band5",
      "B6": "band6", "B7": "band7", "B8": "band5", "B9": "band9", "B10": "band9", "B11": "band6", "B12": "band7"
    };
    const key = bName.toUpperCase();
    if (landsatMap[key]) return landsatMap[key];
  } else if (mission === "Resourcesat-2") {
    const resourcesatMap = {
      "B02": "band2", // Blue/Green
      "B03": "band2", // Green
      "B04": "band3", // Red
      "B08": "band4", // NIR
      "B8A": "band4", // NIR
      "B11": "band5", // SWIR
      "B12": "band5", // SWIR
      "B2": "band2", "B3": "band2", "B4": "band3", "B8": "band4", "B11": "band5"
    };
    const key = bName.toUpperCase();
    if (resourcesatMap[key]) return resourcesatMap[key];
  }

  if (window.currentImageObj && window.currentImageObj.assets) {
    const keys = Object.keys(window.currentImageObj.assets);
    const norm = bName.replace(/^B0?/, "").toLowerCase();
    for (let k of keys) {
      const kNorm = k.replace(/^band0?/, "").toLowerCase();
      if (norm === kNorm) return k;
    }
  }
  return bName.replace("B", "band");
}

async function applyVisualization() {
  if (!vistaImages || vistaImages.length === 0) {
    showToast("No active images loaded. Please search and load images first.", "error");
    return;
  }

  const loading = document.getElementById("loadingOverlay");
  if (loading) loading.classList.remove("hidden");
  
  try {
    const activeTab = document.getElementById("layerOperationSelect").value;
    let queryParams = "";
    
    if (activeTab === "composite") {
      const r = document.getElementById("drop-r").textContent.trim() || "B04";
      const g = document.getElementById("drop-g").textContent.trim() || "B03";
      const b = document.getElementById("drop-b").textContent.trim() || "B02";
      if (r === "B04" && g === "B03" && b === "B02") {
        queryParams = ""; // default TCI
      } else {
        const ar = resolveBand(r);
        const ag = resolveBand(g);
        const ab = resolveBand(b);
        
        let cRescale = "0,3000";
        let targetImg = window.currentImageObj || (vistaImages && vistaImages.length > 0 ? vistaImages[0] : null);
        if (targetImg && targetImg.default_assets) {
          const match = targetImg.default_assets.match(/rescale=([^&]+)/);
          if (match) cRescale = match[1];
        }
        
        queryParams = `?assets=${ar}&assets=${ag}&assets=${ab}&asset_bidx=${ar}|1&asset_bidx=${ag}|1&asset_bidx=${ab}|1&rescale=${cRescale}`;
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
        
        const an1 = resolveBand(n1);
        const an2 = resolveBand(n2);
        const an3 = resolveBand(n3);
        const an4 = resolveBand(n4);
        
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
        
        const ar1 = resolveBand(r1);
        const ar2 = resolveBand(r2);
        
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

      // Replace them in the expression string with resolved asset names for TiTiler
      let exprStr = formulaStr;
      uniqueBands.forEach(b => {
        const assetName = resolveBand(b);
        exprStr = exprStr.replace(new RegExp(`\\b${b}\\b`, 'g'), assetName);
      });
      
      const bidxQuery = uniqueBands.map(b => `asset_bidx=${resolveBand(b)}|1`).join("&");
      const bidxPart = bidxQuery ? `&${bidxQuery}` : "";
      
      const exprEncoded = encodeURIComponent(exprStr);
      const rescaleMin = document.getElementById("formulaRescaleMin")?.value || "-1";
      const rescaleMax = document.getElementById("formulaRescaleMax")?.value || "1";
      queryParams = `?expression=${exprEncoded}${bidxPart}&colormap_name=rdylgn&rescale=${rescaleMin},${rescaleMax}&asset_as_band=true`;
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
      finalTileUrl += "&nodata=0";
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

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// BACKEND STATUS POLLING
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

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
    document.getElementById("statusMsg").textContent = data.message || "â€”";

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

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// GEOCODING SEARCH (Nominatim)
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

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


// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// UI HELPERS
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

function updateZoomInfo() {
  if (!map) return;
  const el = document.getElementById("zoomLevel");
  if (el) el.textContent = map.getZoom();
}

function updateCoords(e) {
  const latEl = document.getElementById("cursorLat");
  const lonEl = document.getElementById("cursorLon");
  if (latEl) latEl.textContent = e.latlng.lat.toFixed(5);
  if (lonEl) lonEl.textContent = e.latlng.lng.toFixed(5);
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
  if (levels.length === 0) return;
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

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// BOOT
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

(async function boot() {
  initMap();

  // Initial checks and scan vista images
  await Promise.all([pollStatus(), checkTiTiler(), initVista()]);

  // Start polling
  setInterval(pollStatus,    POLL_MS);
  setInterval(checkTiTiler,  POLL_MS * 2);


  showToast("EO Platform Ready (Vista Mode)", "info");
})();

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
// TAB SWITCHING & DRAG-AND-DROP INITIALIZATION
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 

document.addEventListener("DOMContentLoaded", () => {
  // Layer operations dropdown
  const opSelect = document.getElementById('layerOperationSelect');
  if (opSelect) {
    // Force the dropdown back to default to prevent browser cache desync
    opSelect.value = "composite";
    
    opSelect.addEventListener('change', (e) => {
      const selected = e.target.value;
      
      // Switch content
      document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");
      const target = document.getElementById("tab-" + selected);
      if (target) target.style.display = "block";
      
      // Initialize Monaco if switching to custom
      if (selected === "custom" && !window.customScriptEditor) {
        if (typeof require !== 'undefined') {
          require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
          require(['vs/editor/editor.main'], function() {
            try {
              window.customScriptEditor = monaco.editor.create(document.getElementById('editor-container'), {
                value: getTemplate('ndvi'),
                language: 'javascript',
                theme: 'vs-dark',
                minimap: { enabled: false },
                automaticLayout: true
              });
            } catch (err) {
              console.error("Monaco editor failed to create:", err);
            }
          });
        } else {
          showToast("Code editor failed to load. Please refresh.", "error");
        }
      }
    });
  }

  // Drag and Drop Logic
  window.draggedItem = null;

  // Search submit
  const btnSearch = document.getElementById("btnSearchSubmit");
  if (btnSearch) {
    btnSearch.addEventListener("click", () => {
      searchImages();
    });
  }

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

      // Auto-preset Rescale Min/Max based on formula type
      const minInput = document.getElementById("formulaRescaleMin");
      const maxInput = document.getElementById("formulaRescaleMax");
      if (minInput && maxInput) {
        if (expr.includes("/") && !expr.includes("+") && !expr.includes("-")) {
          // Looks like a simple ratio (e.g. A/B)
          minInput.value = "0";
          maxInput.value = "3";
        } else if (expr.includes("-") && expr.includes("+") && expr.includes("/")) {
          // Looks like a normalized difference (e.g. (A-B)/(A+B))
          minInput.value = "-1";
          maxInput.value = "1";
        } else if (!expr.includes("/")) {
          // Simple difference or addition, Sentinel-2 band values can be large (0-10000)
          minInput.value = "-4000";
          maxInput.value = "4000";
        } else {
          // Fallback
          minInput.value = "-1";
          maxInput.value = "1";
        }
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

  const btnAnimate = document.getElementById("btnAnimate");
  if (btnAnimate) {
    btnAnimate.addEventListener("click", (e) => {
      e.preventDefault();
      if (!vistaImages || vistaImages.length === 0) {
        showToast("Please search for images first.", "error");
        return;
      }
      initTimeline();
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

  
  // â”€â”€â”€ DOWNLOAD WORKFLOW LOGIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    window.customScriptEditor = null;
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
        q = img.default_assets || "?asset_bidx=TCI|1,TCI|2,TCI|3&asset_as_band=true";
        if (q.startsWith("&")) {
          q = "?" + q.substring(1);
        }
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


  // Custom Script Logic
  const selScriptTemplate = document.getElementById("selScriptTemplate");
  const btnValidateScript = document.getElementById("btnValidateScript");
  const btnApplyScript = document.getElementById("btnApplyScript");
  window.customScriptEditor = null;

  // Monaco initialized via dropdown change listener in the main event handler

  const btnToggleTheme = document.getElementById("btnToggleTheme");
  if (btnToggleTheme) {
    btnToggleTheme.addEventListener("change", (e) => {
      const isDark = e.target.checked;
      if (window.customScriptEditor) {
        monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
      }
    });
  }

  const btnToggleEditor = document.getElementById("btnToggleEditor");
  const editorWrapper = document.getElementById("editor-wrapper");
  if (btnToggleEditor && editorWrapper) {
    let isMaximized = false;
    const placeholder = document.createElement('div');
    editorWrapper.parentNode.insertBefore(placeholder, editorWrapper);

    const editorHeader = editorWrapper.querySelector('.editor-header');
    let isDragging = false;
    let startX, startY, initialTop, initialLeft;

    if (editorHeader) {
      editorHeader.addEventListener('mousedown', (e) => {
        if (!editorWrapper.classList.contains('maximized-editor')) return;
        // Don't drag if clicking buttons or toggles
        if (e.target.closest('button') || e.target.closest('.theme-switch')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = editorWrapper.getBoundingClientRect();
        editorWrapper.style.setProperty('left', rect.left + 'px', 'important');
        editorWrapper.style.setProperty('top', rect.top + 'px', 'important');
        editorWrapper.style.setProperty('transform', 'none', 'important');
        
        initialLeft = rect.left;
        initialTop = rect.top;
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        editorWrapper.style.setProperty('left', (initialLeft + dx) + 'px', 'important');
        editorWrapper.style.setProperty('top', (initialTop + dy) + 'px', 'important');
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    }

    btnToggleEditor.addEventListener("click", () => {
      isMaximized = !isMaximized;
      if (isMaximized) {
        document.body.appendChild(editorWrapper);
        editorWrapper.classList.add("maximized-editor");
        document.body.style.overflow = 'hidden';
        if (editorHeader) editorHeader.style.cursor = 'move';
      } else {
        placeholder.parentNode.insertBefore(editorWrapper, placeholder);
        editorWrapper.classList.remove("maximized-editor");
        document.body.style.overflow = '';
        if (editorHeader) editorHeader.style.cursor = 'default';
        
        // Reset inline styles
        editorWrapper.style.left = '';
        editorWrapper.style.top = '';
        editorWrapper.style.transform = '';
      }
      if (window.customScriptEditor) {
        setTimeout(() => window.customScriptEditor.layout(), 50);
      }
    });
  }

  function getTemplate(name) {
    if (name === 'ndvi') {
      return `//VERSION=DRISHTI-1\n\nfunction setup() {\n    return {\n        input: ["B04", "B08"],\n        output: { bands: 1 }\n    };\n}\n\nfunction evaluatePixel(sample) {\n    let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);\n    return [ndvi];\n}`;
    } else if (name === 'true_color') {
      return `//VERSION=DRISHTI-1\n\nfunction setup() {\n    return {\n        input: ["B02", "B03", "B04"],\n        output: { bands: 3 }\n    };\n}\n\nfunction evaluatePixel(sample) {\n    return [\n        2.5 * sample.B04,\n        2.5 * sample.B03,\n        2.5 * sample.B02\n    ];\n}`;
    } else if (name === 'ndwi') {
      return `//VERSION=DRISHTI-1\n\nfunction setup() {\n    return {\n        input: ["B03", "B08"],\n        output: { bands: 1 }\n    };\n}\n\nfunction evaluatePixel(sample) {\n    let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08);\n    return [ndwi];\n}`;
    }
    return `//VERSION=DRISHTI-1\n\nfunction setup() {\n    return {\n        input: ["B04"],\n        output: { bands: 1 }\n    };\n}\n\nfunction evaluatePixel(sample) {\n    return [sample.B04];\n}`;
  }

  if (selScriptTemplate) {
    selScriptTemplate.addEventListener('change', (e) => {
      if (window.customScriptEditor) {
        window.customScriptEditor.setValue(getTemplate(e.target.value));
      }
    });
  }

  if (btnValidateScript || btnApplyScript) {
    const handleScript = async (apply = false) => {
      if (!window.customScriptEditor) return;
      const scriptCode = window.customScriptEditor.getValue();
      try {
        const loading = document.getElementById("loadingOverlay");
        if (loading) loading.classList.remove("hidden");
        
        const res = await fetch(`${BACKEND_URL}/vista/custom-script/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: scriptCode })
        });
        const data = await res.json();
        
        if (loading) loading.classList.add("hidden");
        
        if (!data.valid) {
          showToast(`Script Error: ${data.error}`, "error");
          return;
        }
        
        if (apply) {
          // Prepare TiTiler expression
          let bidxQuery = data.bands.map(b => `asset_bidx=${resolveBand(b)}|1`).join("&");
          if (bidxQuery) bidxQuery = `&${bidxQuery}`;
          
          // Replace generic band names (B04) in expression with resolved names (band04)
          let exprStr = data.expression;
          data.bands.forEach(b => {
            const assetName = resolveBand(b);
            exprStr = exprStr.replace(new RegExp(`\\b${b}\\b`, 'g'), assetName);
          });
          
          const exprEncoded = encodeURIComponent(exprStr);
          
          let rescale = data.output_bands === 3 ? "0,3000" : "-1,1";
          let cmapQuery = data.output_bands === 1 ? "&colormap_name=rdylgn" : "";
          
          currentQueryParams = `?expression=${exprEncoded}${bidxQuery}${cmapQuery}&rescale=${rescale}&asset_as_band=true`;
          // Apply globally
          vistaImages.forEach((imgObj) => {
            let finalTileUrl = imgObj.base_tile_url;
            finalTileUrl += currentQueryParams.replace("?", "&");
            finalTileUrl += "&nodata=0";
            imgObj.layer.setUrl(finalTileUrl);
          });
          showToast("Custom Script Applied!", "success");
        } else {
          showToast("Script is Valid!", "success");
        }
      } catch (e) {
        showToast("Error validating script", "error");
        const loading = document.getElementById("loadingOverlay");
        if (loading) loading.classList.add("hidden");
      }
    };
    
    if (btnValidateScript) btnValidateScript.addEventListener('click', () => handleScript(false));
    if (btnApplyScript) btnApplyScript.addEventListener('click', () => handleScript(true));
  }
});

// --- TIMELINE LOGIC ---
let timelineDates = [];
let timelineCurrentIndex = -1;
window.timelinePlaybackInterval = null;
window.timelineHighlightLayer = null;

function initTimeline() {
  const container = document.getElementById("timelineContainer");
  if (!container) return;
  
  container.style.display = "block";
  
  // Extract unique dates from vistaImages and group them
  const dateMap = new Map();
  vistaImages.forEach(img => {
    // Expected format: YYYY-MM-DD or similar
    const dStr = img.date;
    if (!dateMap.has(dStr)) {
      dateMap.set(dStr, []);
    }
    dateMap.get(dStr).push(img);
  });
  
  // Sort dates chronologically
  timelineDates = Array.from(dateMap.keys()).sort((a, b) => new Date(a) - new Date(b));
  
  if (timelineDates.length === 0) {
    showToast("No imagery dates available to animate.", "error");
    container.style.display = "none";
    return;
  }
  
  renderTimelineTicks();
  
  // Select the first date
  selectTimelineDate(0);
  
  // Setup button listeners
  document.getElementById("btnTimelinePrev").onclick = () => {
    pauseTimeline();
    if (timelineCurrentIndex > 0) selectTimelineDate(timelineCurrentIndex - 1);
  };
  document.getElementById("btnTimelineNext").onclick = () => {
    pauseTimeline();
    if (timelineCurrentIndex < timelineDates.length - 1) selectTimelineDate(timelineCurrentIndex + 1);
  };
  
  const playBtn = document.getElementById("btnTimelinePlay");
  playBtn.onclick = () => {
    if (window.timelinePlaybackInterval) {
      pauseTimeline();
    } else {
      playTimeline();
    }
  };
}

function renderTimelineTicks() {
  const ticksContainer = document.getElementById("timelineTicks");
  ticksContainer.innerHTML = "";
  
  if (timelineDates.length <= 1) return;
  
  // Enforce minimum width to prevent date overlap
  const track = document.getElementById("timelineTrack");
  if (track) {
    const minSpacing = 70; // min px per date block
    track.style.minWidth = `max(calc(100% - 60px), ${timelineDates.length * minSpacing}px)`;
  }
  
  timelineDates.forEach((dateStr, index) => {
    // Space dates evenly by index to prevent overlap
    let pct = 0;
    if (timelineDates.length > 1) {
      pct = (index / (timelineDates.length - 1)) * 100;
    }
    
    // Create tick
    const tick = document.createElement("div");
    tick.className = "timeline-tick";
    tick.style.left = pct + "%";
    tick.dataset.index = index;
    
    // Date Label
    const dateObj = new Date(dateStr);
    const shortDate = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const label = document.createElement("div");
    label.className = "timeline-label";
    label.textContent = shortDate;
    tick.appendChild(label);
    
    // Tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "timeline-tooltip";
    
    // Get corresponding images to show in tooltip
    const imgs = vistaImages.filter(i => i.date === dateStr);
    let tooltipText = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + "\n";
    if (imgs.length > 0) {
      tooltipText += imgs[0].name.split('_')[0] || "Satellite";
      if (imgs[0].cloud !== undefined) tooltipText += `\nCloud Cover: ${imgs[0].cloud.toFixed(1)}%`;
    }
    tooltip.textContent = tooltipText;
    tick.appendChild(tooltip);
    
    // Interactions
    tick.onclick = () => {
      pauseTimeline();
      selectTimelineDate(index);
    };
    
    // Temp highlight on hover
    tick.onmouseenter = () => {
      if (index !== timelineCurrentIndex) {
        highlightFootprint(dateStr, true);
      }
    };
    tick.onmouseleave = () => {
      if (index !== timelineCurrentIndex) {
        // Restore current
        if (timelineCurrentIndex >= 0) {
           highlightFootprint(timelineDates[timelineCurrentIndex], false);
        } else {
           if (window.timelineHighlightLayer) map.removeLayer(window.timelineHighlightLayer);
        }
      }
    };
    
    ticksContainer.appendChild(tick);
  });
}

function selectTimelineDate(index) {
  if (index < 0 || index >= timelineDates.length) return;
  timelineCurrentIndex = index;
  const dateStr = timelineDates[index];
  
  // Update UI active states
  const ticks = document.querySelectorAll(".timeline-tick");
  ticks.forEach(t => t.classList.remove("active"));
  
  let targetPct = 0;
  if (timelineDates.length > 1) {
    targetPct = (index / (timelineDates.length - 1)) * 100;
  }
  
  const activeTick = document.querySelector(`.timeline-tick[data-index="${index}"]`);
  if (activeTick) {
    activeTick.classList.add("active");
    activeTick.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  
  // Move pointer
  const pointer = document.getElementById("timelinePointer");
  if (pointer) {
    pointer.style.left = targetPct + "%";
  }
  
  // Update Text
  const dateObj = new Date(dateStr);
  document.getElementById("timelineCurrentDate").textContent = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  
  const imgs = vistaImages.filter(i => i.date === dateStr);
  if (imgs.length > 0) {
    const img = imgs[0]; // pick first if multiple
    let metaTxt = `${img.name.split('_')[0] || "Unknown Satellite"}`;
    if (img.cloud !== undefined) metaTxt += ` • Cloud: ${img.cloud.toFixed(1)}%`;
    if (img.res !== undefined) metaTxt += ` • Res: ${img.res}`;
    document.getElementById("timelineMetadata").textContent = metaTxt;
  }
  
  // Highlight Footprint
  highlightFootprint(dateStr, false);
}

function highlightFootprint(dateStr, isTemporary) {
  if (window.timelineHighlightLayer) {
    map.removeLayer(window.timelineHighlightLayer);
    window.timelineHighlightLayer = null;
  }
  
  const imgs = vistaImages.filter(i => i.date === dateStr);
  if (imgs.length === 0) return;
  
  // We can group multiple geometries if there are multiple images on same date
  const features = imgs.filter(i => i.bbox).map(i => {
    const [w, s, e, n] = i.bbox;
    // Leaflet LatLng is [lat, lon]
    return L.polygon([
      [s, w],
      [n, w],
      [n, e],
      [s, e]
    ]);
  });
  
  if (features.length > 0) {
    window.timelineHighlightLayer = L.featureGroup(features).addTo(map);
    // Apply styling via class (defined in CSS)
    window.timelineHighlightLayer.eachLayer(layer => {
      L.DomUtil.addClass(layer._path, 'timeline-highlight');
      if (isTemporary) {
        // slightly different styling for temporary? just use CSS or leave it.
        layer.setStyle({ color: '#fff', weight: 1, dashArray: '5, 5' });
      } else {
        layer.setStyle({ color: '#00e5ff', weight: 3, fillOpacity: 0.1 });
      }
    });
  }
}

function playTimeline() {
  const playBtn = document.getElementById("btnTimelinePlay");
  playBtn.innerHTML = "❚❚ PAUSE";
  playBtn.classList.add("active");
  
  window.timelinePlaybackInterval = setInterval(() => {
    let nextIndex = timelineCurrentIndex + 1;
    if (nextIndex >= timelineDates.length) {
      nextIndex = 0; // loop back to start
    }
    selectTimelineDate(nextIndex);
  }, 1500); // 1.5 seconds interval
}

function pauseTimeline() {
  if (window.timelinePlaybackInterval) {
    clearInterval(window.timelinePlaybackInterval);
    window.timelinePlaybackInterval = null;
  }
  const playBtn = document.getElementById("btnTimelinePlay");
  playBtn.innerHTML = "▶ PLAY";
  playBtn.classList.remove("active");
}

