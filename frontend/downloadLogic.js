/**
 * downloadLogic.js
 * Handles the interactive selection and downloading of images as a zip package.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Wait for the Leaflet map to be available
  const checkMap = setInterval(() => {
    if (typeof map !== 'undefined' && map !== null) {
      clearInterval(checkMap);
      initDownloadControl();
    }
  }, 500);

  let isDownloadSelectionMode = false;
  let targetSelectionCount = 0;
  let selectedImages = [];
  let downloadSelectionLayer = L.featureGroup();

  function initDownloadControl() {
    const DownloadControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function() {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
        container.style.backgroundColor = 'white';
        container.style.width = '34px';
        container.style.height = '34px';
        container.style.lineHeight = '34px';
        container.style.textAlign = 'center';
        container.style.cursor = 'pointer';
        container.style.fontSize = '18px';
        container.innerHTML = '📥';
        container.title = 'Download Images';
        container.onclick = function(e) {
          e.stopPropagation();
          openDownloadCountModal();
        };
        return container;
      }
    });
    map.addControl(new DownloadControl());
    map.addLayer(downloadSelectionLayer);
  }

  function openDownloadCountModal() {
    document.getElementById("downloadCountModal").classList.remove("hidden");
    document.getElementById("downloadCountInput").value = 1;
  }

  document.getElementById("btnCancelDownloadCount").addEventListener("click", () => {
    document.getElementById("downloadCountModal").classList.add("hidden");
  });

  document.getElementById("btnConfirmDownloadCount").addEventListener("click", () => {
    const count = parseInt(document.getElementById("downloadCountInput").value);
    if (isNaN(count) || count < 1) return;
    
    targetSelectionCount = count;
    document.getElementById("downloadCountModal").classList.add("hidden");
    startSelectionMode();
  });

  function startSelectionMode() {
    if (typeof vistaImages === 'undefined' || vistaImages.length === 0) {
      alert("No images available to select.");
      return;
    }

    isDownloadSelectionMode = true;
    selectedImages = [];
    downloadSelectionLayer.clearLayers();

    // Draw bounding boxes for all active images
    vistaImages.forEach(img => {
      // Create a polygon from the bounds
      const bounds = [[img.bbox[1], img.bbox[0]], [img.bbox[3], img.bbox[2]]];
      const poly = L.rectangle(bounds, {
        color: '#00f2fe',
        weight: 2,
        fillColor: '#00f2fe',
        fillOpacity: 0.1,
        interactive: true
      });

      poly.imgData = img; // store metadata

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        toggleImageSelection(poly);
      });

      poly.addTo(downloadSelectionLayer);
    });
    
    // Bring to front
    downloadSelectionLayer.bringToFront();
    if (typeof showToast !== 'undefined') showToast(`Select ${targetSelectionCount} images on the map.`, "success");
  }

  function toggleImageSelection(poly) {
    if (!isDownloadSelectionMode) return;

    const index = selectedImages.indexOf(poly.imgData);
    if (index === -1) {
      // Select
      if (selectedImages.length >= targetSelectionCount) {
        if (typeof showToast !== 'undefined') showToast(`You have already selected ${targetSelectionCount} images.`, "error");
        return;
      }
      selectedImages.push(poly.imgData);
      poly.setStyle({ color: '#ff0055', fillColor: '#ff0055', fillOpacity: 0.4 });
    } else {
      // Deselect
      selectedImages.splice(index, 1);
      poly.setStyle({ color: '#00f2fe', fillColor: '#00f2fe', fillOpacity: 0.1 });
    }

    if (selectedImages.length === targetSelectionCount) {
      setTimeout(() => {
        endSelectionMode();
      }, 500);
    }
  }

  function endSelectionMode() {
    isDownloadSelectionMode = false;
    downloadSelectionLayer.clearLayers();
    openDownloadPreviewModal();
  }

  function openDownloadPreviewModal() {
    const container = document.getElementById("downloadThumbnails");
    container.innerHTML = "";
    
    selectedImages.forEach((img, idx) => {
      const url = `http://localhost:8000/vista/stac/${img.name}`;
      let queryParams = "";
      if (typeof currentQueryParams !== 'undefined' && currentQueryParams) {
        queryParams = currentQueryParams.replace("?expression=", "&expression=");
        if (queryParams.startsWith('?')) {
           queryParams = '&' + queryParams.substring(1);
        }
      } else {
        queryParams = "&asset_bidx=B04|1&asset_bidx=B03|1&asset_bidx=B02|1"; // default True Color
      }

      // Generate a TiTiler preview URL
      const previewUrl = `http://localhost:8001/stac/preview.png?url=${encodeURIComponent(url)}${queryParams}`;
      
      const imgEl = document.createElement("img");
      imgEl.src = previewUrl;
      imgEl.style.width = "120px";
      imgEl.style.height = "120px";
      imgEl.style.objectFit = "cover";
      imgEl.style.border = "2px solid #00f2fe";
      imgEl.style.borderRadius = "4px";
      imgEl.title = img.name;
      
      container.appendChild(imgEl);
      
      // Store final URL for download
      img.downloadUrl = previewUrl;
    });

    document.getElementById("downloadPreviewModal").classList.remove("hidden");
  }

  document.getElementById("btnCancelDownloadFinal").addEventListener("click", () => {
    document.getElementById("downloadPreviewModal").classList.add("hidden");
    selectedImages = [];
  });

  document.getElementById("btnFinalDownload").addEventListener("click", async () => {
    const btn = document.getElementById("btnFinalDownload");
    btn.textContent = "Packaging...";
    btn.disabled = true;

    try {
      const zip = new JSZip();
      const folder = zip.folder("DRISHTI");

      for (let i = 0; i < selectedImages.length; i++) {
        const img = selectedImages[i];
        try {
          const response = await fetch(img.downloadUrl);
          const blob = await response.blob();
          folder.file(`${img.name}.png`, blob);
        } catch (err) {
          console.error("Failed to fetch image:", img.name, err);
        }
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, "DRISHTI.zip");

      document.getElementById("downloadPreviewModal").classList.add("hidden");
      if (typeof showToast !== 'undefined') showToast("Download Complete!", "success");
    } catch (e) {
      console.error(e);
      if (typeof showToast !== 'undefined') showToast("Error packaging images", "error");
    } finally {
      btn.textContent = "Download Package (DRISHTI.zip)";
      btn.disabled = false;
      selectedImages = [];
    }
  });
});
