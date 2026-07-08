# EO Platform System Working Document

This document explains the actual, implemented workings of the Earth Observation (EO) platform, strictly based on the current codebase.

## 1. Overall System Working
The system is divided into an automated data processing pipeline, a web backend, a tile server, and a frontend viewer. 
- **Processing**: A background thread (`backend/processing.py`) continuously scans the `backend/data` folder for new Sentinel-2 imagery (.SAFE folders or raw .tif files).
- **Conversion**: It extracts the needed bands (B01-B12) and converts them into Cloud Optimized GeoTIFFs (COGs). 
- **Serving**: The FastAPI backend manages a PostgreSQL database with metadata (Bounding Box, resolutions, file paths). It exposes API endpoints for the frontend to list datasets.
- **Viewing**: The frontend uses Leaflet to display the map. When a dataset is selected, FastAPI gives the frontend a TileJSON object pointing to the **TiTiler** server. TiTiler dynamically generates image tiles from the COGs, allowing the user to view massive satellite images seamlessly.

## 2. Docker Storage & Image Access
**Where are they stored?** The images are stored locally on the host machine inside the `backend/cogs` directory after being converted by the processing script. 
**How are they accessed?** In `docker-compose.yml`, this local directory is mapped directly into the TiTiler Docker container as a volume: `- ./backend/cogs:/app/cogs`. TiTiler accesses these files via direct local file URIs like `file:///app/cogs/image_B04.tif`. MinIO is *not* used in the current implementation.

## 3. TiTiler: What it is and how it is used
**What is it?** TiTiler is a dynamic tile server built specifically for Cloud Optimized GeoTIFFs (COGs).
**How is it used?** Browsers cannot load a 2-Gigabyte GeoTIFF file. Instead, the Leaflet map breaks the screen into 256x256 pixel grid "tiles". For each tile, Leaflet makes a request to TiTiler. TiTiler looks at the COG file, reads *only* the specific bytes needed for that tiny square (using internal TIFF overviews and Range Requests), renders it as a lightweight PNG/JPEG, and sends it to the frontend.

## 4. Band Arithmetic
Band arithmetic is handled in two ways in this system:
1. **Pre-calculated (Background)**: In `processing.py`, Python libraries `xarray` and `rioxarray` open the Red and NIR bands. They perform the mathematical operation `(NIR - Red) / (NIR + Red)` directly on the arrays. The output is saved to Zarr for speed, and exported as a new pre-calculated COG (e.g., `_NDVI.tif`).
2. **On-the-fly (Frontend)**: In the frontend "Index" tab, users can drag and drop bands into a formula. The frontend builds a query parameter (e.g., `?expression=(b1-b2)/(b1+b2)`) and sends it to TiTiler. 

## 5. Is TiTiler showing the output of Band Arithmetic?
**Yes.** TiTiler is entirely responsible for displaying the output. 
- When viewing pre-calculated indices, TiTiler just serves tiles from the `_NDVI.tif` COG.
- When doing on-the-fly arithmetic, TiTiler reads multiple bands (e.g., B04 and B08) at the same time, performs the math for that specific map tile pixel-by-pixel in memory, applies a colormap (like `rdylgn` - Red/Yellow/Green), and outputs the colored image tile to the browser.

## 6. How Vista Mode Works
Vista mode (`backend/vista.py`) is designed to create a large, seamless mosaic of multiple satellite images.
- It scans the `vista_data` directory looking for Sentinel-2 metadata files (`MTD_MSIL*.xml`).
- It extracts the **Cloud Cover percentage** and the **Acquisition Date**.
- It locates the True Color Image (TCI) file (e.g., `_TCI_10m.jp2`) for that specific capture.
- It ranks all the images it found based on a strict priority: **Lowest Cloud Cover first**, then the most recent date, then the highest resolution.

## 7. How Images are Combined (MosaicJSON)
Images in Vista mode are combined dynamically using a **MosaicJSON**. 
- `vista.py` takes the sorted list of True Color Images and feeds their paths into the `cogeo_mosaic` library.
- This creates a JSON document defining a spatial grid. For any point on the grid, it lists which satellite images cover that area, in priority order (best images on top).
- TiTiler reads this MosaicJSON. When Leaflet requests a tile, TiTiler looks up the images covering that tile, fetches the data from the best (top) image, and if there are gaps or edges, fills them in with the images underneath, merging them into a single seamless output tile.

## 8. Background Map (Indian Map Draft)
The background map outline of India is added **only when Vista Mode is activated**.
- When a user clicks the "Vista" button, the script `frontend/vista.js` runs.
- It dynamically fetches a local GeoJSON file named `india_states.geojson` from the backend (`/static/india_states.geojson`).
- It then adds this GeoJSON data to the Leaflet map as a vector layer with a specific style: thin grey lines (`color: "#9ca3af"`) and a completely transparent fill (`fillOpacity: 0`). 
- This creates the clean, minimalist outline of the Indian states you see in the background, serving as a geographic reference without cluttering the satellite data.
- When you switch back to the standard Satellite mode, this GeoJSON outline layer is removed.

## 9. Automatic Placement in Vista
There is no manual positioning required to place the images accurately on the map of India. 
1. All GeoTIFFs and JP2 files contain embedded **geospatial coordinates** (Bounding Box / CRS). 
2. When TiTiler processes a file, it reads these embedded coordinates.
3. TiTiler tells Leaflet exactly where on the globe this image belongs.
4. Because the `india_states.geojson` map outline and the satellite images both use the same real-world coordinate system, Leaflet automatically places the satellite images exactly over the correct states (e.g., Rajasthan, Maharashtra) with pixel-perfect accuracy.
