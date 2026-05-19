# EO Platform — Cloud-Based Satellite Image Visualization
**Hyderabad Region · Sentinel-2 · COG + TiTiler + FastAPI + Leaflet**

---

## Architecture Overview

```
Browser (Leaflet)
      │  tile requests (XYZ)
      ▼
TiTiler  :8001  ──── reads ────► output_cog.tif
      
FastAPI  :8000  ──── REST ────► frontend + processing
      │
processing.py  ──── GDAL/Rasterio ────► input.tif → output_cog.tif
```

---

## Project Structure

```
eo-platform/
├── backend/
│   ├── main.py            ← FastAPI REST API
│   ├── processing.py      ← TIFF → COG converter (threaded)
│   ├── requirements.txt
│   └── data/
│       ├── input.tif      ← Place your satellite image here
│       └── output_cog.tif ← Generated automatically
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
│
└── README.md
```

---

## Quick Start

### 1. Install Python dependencies

```bash
cd backend
pip install -r requirements.txt
```

> **GDAL note (Windows):** Install GDAL via OSGeo4W installer first:
> https://trac.osgeo.org/osgeo4w/
>
> **Linux/macOS:**
> ```bash
> sudo apt install gdal-bin libgdal-dev   # Ubuntu/Debian
> brew install gdal                        # macOS
> ```

---

### 2. Download a Satellite Image

Download a cloud-free Sentinel-2 GeoTIFF of Hyderabad from either:

- **Copernicus Browser** → https://browser.dataspace.copernicus.eu
- **USGS EarthExplorer** → https://earthexplorer.usgs.gov

Save it as:
```
backend/data/input.tif
```

### 3. One-step startup (recommended)

Use the provided Windows script to set up the environment and launch both servers automatically:

```bat
run_eo_platform.bat
```

This will:
- create and activate `backend/.venv` if missing
- install `backend/requirements.txt`
- start TiTiler on `http://localhost:8001`
- start the FastAPI backend on `http://localhost:8000`

If you need only the backend or frontend, follow the manual startup below.

Requirements:
- Format: GeoTIFF (.tif)
- Cloud cover: < 10%
- Area: Hyderabad / HITEC City / Charminar

---

### 3. Convert TIFF → COG (Two options)

#### Option A — via Python (recommended)
```bash
cd backend
python processing.py
```

#### Option B — via GDAL CLI
```bash
# Convert to COG
gdal_translate input.tif output_cog.tif -of COG -co COMPRESS=LZW

# Add pyramid overviews
gdaladdo output_cog.tif 2 4 8 16
```

Both options create `backend/data/output_cog.tif`.

---

### 4. Start TiTiler (tile server)

```bash
# In a new terminal
uvicorn titiler.application.main:app --port 8001 --reload
```

Docs: http://localhost:8001/docs

---

### 5. Start FastAPI Backend

```bash
# In a new terminal
cd backend
uvicorn main:app --port 8000 --reload
```

API docs: http://localhost:8000/docs

---

### 6. Open the Frontend

Open `frontend/index.html` directly in your browser, **or** serve it:

```bash
# Python simple server
cd frontend
python -m http.server 3000
```

Then visit: http://localhost:3000

---

## API Reference

| Method | Endpoint              | Description                    |
|--------|-----------------------|--------------------------------|
| GET    | `/`                   | Health check                   |
| GET    | `/api/status`         | COG conversion status + progress |
| POST   | `/api/process`        | Trigger TIFF → COG conversion  |
| GET    | `/api/info`           | COG spatial metadata           |
| GET    | `/api/cog/tilejson`   | TileJSON for Leaflet            |
| GET    | `/api/bands`          | Per-band statistics            |

---

## COG Explained

| Feature | Normal TIFF | Cloud Optimized GeoTIFF |
|---------|------------|--------------------------|
| Loading | Entire file | Only required tiles       |
| Zoom    | Slow        | Fast (pyramid overviews)  |
| Memory  | High        | Low                       |
| Cloud   | ✗           | ✓ (HTTP Range Requests)   |

### Pyramid Levels

```
Level 0  ████████████████  Full resolution  (zoom 15-18)
Level 1  ████████          Half             (zoom 11-14)
Level 2  ████              Quarter          (zoom  6-10)
Level 3  ██                Thumbnail        (zoom  0-5)
```

---

## Technology Stack

| Component    | Technology         |
|--------------|--------------------|
| Frontend     | HTML5 / CSS3 / JS  |
| Map engine   | Leaflet.js 1.9     |
| Tile server  | TiTiler            |
| Backend API  | FastAPI + Uvicorn  |
| Image I/O    | Rasterio           |
| COG creation | rio-cogeo           |
| Raster tools | GDAL               |
| Image format | Cloud Optimized GeoTIFF |

---

## Frontend Features

- Dark satellite/GIS aesthetic
- Real-time backend + TiTiler status polling
- Layer switcher: Satellite COG / Streets / NDVI
- COG metadata display (dimensions, CRS, overviews, file size)
- Active pyramid level indicator (updates on zoom)
- Geocoding search (Nominatim / OpenStreetMap)
- Live cursor coordinates
- Toast notifications

---

## Optional: NDVI Visualization

Requires Sentinel-2 multi-band image with NIR (Band 8) and Red (Band 4).

TiTiler NDVI URL pattern:
```
/cog/tiles/{z}/{x}/{y}?url=output_cog.tif
  &expression=(b8-b4)/(b8+b4)
  &rescale=-1,1
  &colormap_name=rdylgn
```

---

## Future Improvements

- [ ] Multi-temporal slider (before/after comparison)
- [ ] Land-use classification (ML)
- [ ] Change detection
- [ ] GeoJSON polygon overlay
- [ ] Distance / area measurement tools
- [ ] STAC API integration (PostgreSQL + pgSTAC)
- [ ] MinIO / AWS S3 storage backend
- [ ] User authentication

---

## Viva Keywords

> Cloud Optimized GeoTIFF · Pyramid Overviews · Dynamic Tile Serving ·
> HTTP Range Requests · XYZ Tile System · REST API · Web GIS ·
> Remote Sensing · Geospatial Visualization · Tile-based Rendering

---

## Project Title (Recommended)

**"Cloud-Based EO Data Visualization Platform Using COG and TiTiler for Hyderabad Region"**
# Eo-platform
