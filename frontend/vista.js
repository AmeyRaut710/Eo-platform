let vistaLayers = [];
let vistaImages = [];
let vistaBaseMap = null;
let originalMapBackground = "";

async function activateVista() {
    // Call the global activateLayer from app.js to clear other layers
    if (typeof activateLayer === 'function') {
        activateLayer('vista');
    }
    
    const btnVista = document.getElementById("btnVista");
    if (btnVista) btnVista.classList.add("active");
    
    // Hide satellite UI panels
    const leftPanel = document.querySelector(".left-panel");
    if (leftPanel) leftPanel.style.display = "none";
    
    const vistaPanel = document.querySelector(".vista-panel");
    if (vistaPanel) vistaPanel.style.display = "block";
    
    const layerOpsCard = document.getElementById("layerOpsCard");
    if (layerOpsCard) layerOpsCard.style.display = "none";
    
    const metaCard = document.getElementById("cardMeta");
    if (metaCard) metaCard.style.display = "none";
    
    // Change map background to clean light colour
    const mapElement = document.getElementById("map");
    if (mapElement) {
        if (!originalMapBackground) originalMapBackground = mapElement.style.backgroundColor;
        mapElement.style.backgroundColor = "#f8f9fa";
    }

    // Add India GeoJSON base map if not added
    if (!vistaBaseMap && typeof map !== 'undefined') {
        try {
            const geoRes = await fetch("/static/india_states.geojson");
            if (geoRes.ok) {
                const geoData = await geoRes.json();
                vistaBaseMap = L.geoJSON(geoData, {
                    style: {
                        color: "#9ca3af", // Thin grey lines
                        weight: 1,
                        fillOpacity: 0 // No fill, transparent
                    }
                });
                vistaBaseMap.addTo(map);
            }
        } catch (e) {
            console.error("Failed to load India GeoJSON:", e);
        }
    } else if (vistaBaseMap && typeof map !== 'undefined') {
        vistaBaseMap.addTo(map);
    }

    // Load images
    if (vistaLayers.length === 0) {
        if (typeof showToast === 'function') showToast("Loading Vista Mode...", "info");
        try {
            const loading = document.getElementById("loadingOverlay");
            if (loading) loading.classList.remove("hidden");

            const res = await fetch(`${BACKEND_URL}/vista/images`);
            if (!res.ok) throw new Error("Failed to load vista images");
            
            const images = await res.json();
            const reversedImages = [...images].reverse();
            
            let firstBounds = null;

            for (const img of reversedImages) {
                // Fetch TileJSON from TiTiler to get accurate bounds, minzoom, maxzoom
                const tileJsonUrl = `${TITILER_URL}/cog/WebMercatorQuad/tilejson.json?url=${encodeURIComponent(img.tci_url)}`;
                const tjRes = await fetch(tileJsonUrl);
                if (!tjRes.ok) continue;
                
                const tj = await tjRes.json();
                
                const layer = L.tileLayer(tj.tiles[0], {
                    minZoom: 2,
                    maxZoom: 24,
                    minNativeZoom: tj.minzoom || 1,
                    maxNativeZoom: tj.maxzoom || 24,
                    bounds: tj.bounds ? [[tj.bounds[1], tj.bounds[0]], [tj.bounds[3], tj.bounds[2]]] : undefined,
                    attribution: `Vista - ${img.name}`,
                    opacity: 1,
                    tileSize: 256,
                    keepBuffer: 4,
                });
                
                vistaLayers.push(layer);
                vistaImages.push({
                    name: img.name,
                    date: img.acquisition_date,
                    cloud: img.cloud_cover,
                    res: img.resolution,
                    layer: layer
                });
                
                // Save the bounds of the "best" image (which is processed last in the loop)
                if (tj.bounds) {
                    firstBounds = tj.bounds;
                }
            }
            
            // Populate Left Panel UI (list items in normal priority order, i.e., best first)
            const vistaLayerList = document.getElementById("vistaLayerList");
            if (vistaLayerList && vistaImages.length > 0) {
                vistaLayerList.innerHTML = "";
                // Reverse the array again so best priority shows at top of the list
                const sortedImages = [...vistaImages].reverse();
                sortedImages.forEach((imgObj, idx) => {
                    const div = document.createElement("div");
                    div.className = "dataset-item";
                    div.style.marginBottom = "10px";
                    div.style.padding = "8px";
                    div.style.border = "1px solid var(--border)";
                    div.style.borderRadius = "4px";
                    
                    const dateStr = imgObj.date.split("T")[0];
                    div.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <strong style="color:var(--text-light); font-size:13px;">${imgObj.name}</strong>
                            <button class="icon-btn toggle-vis" data-idx="${idx}" style="cursor:pointer; background:none; border:none; color:var(--text-light);">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                    <circle cx="12" cy="12" r="3"></circle>
                                </svg>
                            </button>
                        </div>
                        <div style="font-size:11px; color:var(--text-dim);">
                            Date: ${dateStr}<br/>
                            Cloud Cover: ${imgObj.cloud.toFixed(2)}%<br/>
                            Res: ${imgObj.res}m
                        </div>
                    `;
                    
                    div.querySelector('.toggle-vis').addEventListener("click", function() {
                        const isVisible = map.hasLayer(imgObj.layer);
                        if (isVisible) {
                            map.removeLayer(imgObj.layer);
                            this.style.opacity = "0.4";
                        } else {
                            imgObj.layer.addTo(map);
                            this.style.opacity = "1";
                        }
                    });
                    
                    vistaLayerList.appendChild(div);
                });
            }

            // Fit bounds so the map actually moves to the image location!
            if (firstBounds && typeof map !== 'undefined') {
                const [w, s, e, n] = firstBounds;
                map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
            }

            if (loading) loading.classList.add("hidden");
            if (typeof showToast === 'function') showToast("Vista Mode Ready", "success");
        } catch (e) {
            console.error("Vista Mode Error:", e);
            if (typeof showToast === 'function') showToast("Error loading Vista Mode", "error");
            const loading = document.getElementById("loadingOverlay");
            if (loading) loading.classList.add("hidden");
            return;
        }
    }
    
    if (typeof map !== 'undefined') {
        vistaLayers.forEach(layer => {
            if (!map.hasLayer(layer)) layer.addTo(map);
        });
    }
}

function deactivateVista() {
    if (typeof map !== 'undefined') {
        vistaLayers.forEach(layer => map.removeLayer(layer));
        if (vistaBaseMap) {
            map.removeLayer(vistaBaseMap);
        }
    }
    
    const vistaPanel = document.querySelector(".vista-panel");
    if (vistaPanel) vistaPanel.style.display = "none";
    
    const leftPanel = document.querySelector(".left-panel");
    if (leftPanel) leftPanel.style.display = "block";
    
    const mapElement = document.getElementById("map");
    if (mapElement && originalMapBackground) {
        mapElement.style.backgroundColor = originalMapBackground;
    }
    
    // Restore cards if a dataset was already active in Satellite mode
    if (typeof currentActiveDataset !== 'undefined' && currentActiveDataset) {
        const layerOpsCard = document.getElementById("layerOpsCard");
        if (layerOpsCard) layerOpsCard.style.display = "block";
        const metaCard = document.getElementById("cardMeta");
        if (metaCard) metaCard.style.display = "block";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const btnVista = document.getElementById("btnVista");
    if (btnVista) {
        btnVista.addEventListener("click", activateVista);
    }
    
    const btnSatellite = document.getElementById("btnSatellite");
    if (btnSatellite) {
        btnSatellite.addEventListener("click", deactivateVista);
    }
});
