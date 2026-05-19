

import os
import json
import subprocess
import sys
from pathlib import Path
import urllib.parse

import rasterio
from rasterio.warp import transform_bounds
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse, Response
import httpx

from processing import (
    convert_to_cog,
    start_processing_thread,
    processing_status,
    OUTPUT_FILE,
    INPUT_FILE,
    DATA_DIR,
    BASE_DIR,
)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="EO Platform API",
    description="Earth Observation Satellite Image Visualization Backend",
    version="1.0.0",
)

# ── CORS (allow all origins for local dev) ────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static files (serve frontend) ─────────────────────────────────────────────
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ══════════════════════════════════════════════════════════════════════════════
# Routes
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health", summary="Health check")
def health():
    return {
        "status": "running",
        "service": "EO Platform Backend",
        "version": "1.0.0",
        "endpoints": {
            "process":  "POST /api/process",
            "status":   "GET  /api/status",
            "info":     "GET  /api/info",
            "tilejson": "GET  /api/cog/tilejson",
            "docs":     "GET  /docs",
        },
    }


@app.get("/", summary="Frontend")
def index():
    """Serve the frontend UI so the whole app runs with a single backend start."""
    index_path = os.path.join(os.path.dirname(BASE_DIR), "frontend", "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(index_path)


@app.get("/api/health", summary="Health check (alias)")
def api_health():
    return health()




@app.get("/api/status", summary="COG conversion status")
def get_status():
    """Return current status of the TIFF → COG conversion."""
    return {
        "input_exists":  os.path.exists(INPUT_FILE),
        "cog_exists":    os.path.exists(OUTPUT_FILE),
        "cog_size_mb":   (
            round(os.path.getsize(OUTPUT_FILE) / 1_048_576, 2)
            if os.path.exists(OUTPUT_FILE) else None
        ),
        **processing_status,
    }


@app.post("/api/process", summary="Trigger TIFF → COG conversion")
def trigger_processing(background_tasks: BackgroundTasks):
    """
    Start the TIFF → COG conversion in a background thread.
    Idempotent — safe to call multiple times.
    """
    if processing_status["running"]:
        return {"message": "Processing already in progress.",
                "status": processing_status}

    if not os.path.exists(INPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Input file not found at {INPUT_FILE}. "
                "Place your satellite GeoTIFF at backend/data/input.tif"
            ),
        )

    background_tasks.add_task(convert_to_cog)
    return {"message": "Processing started.", "status": processing_status}


@app.get("/api/info", summary="COG file metadata")
def get_cog_info():
    """Return spatial metadata about the COG file."""
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    with rasterio.open(OUTPUT_FILE) as src:
        # Transform bounds to WGS84 for Leaflet
        bounds_wgs84 = transform_bounds(
            src.crs, "EPSG:4326",
            *src.bounds,
            densify_pts=21,
        )
        center_lon = (bounds_wgs84[0] + bounds_wgs84[2]) / 2
        center_lat = (bounds_wgs84[1] + bounds_wgs84[3]) / 2

        return {
            "file":       os.path.basename(OUTPUT_FILE),
            "size_mb":    round(os.path.getsize(OUTPUT_FILE) / 1_048_576, 2),
            "width":      src.width,
            "height":     src.height,
            "bands":      src.count,
            "dtype":      src.dtypes[0],
            "crs":        str(src.crs),
            "nodata":     src.nodata,
            "overviews":  src.overviews(1),
            "bounds_wgs84": {
                "west":  bounds_wgs84[0],
                "south": bounds_wgs84[1],
                "east":  bounds_wgs84[2],
                "north": bounds_wgs84[3],
            },
            "center": {"lat": center_lat, "lon": center_lon},
            "driver":     src.driver,
        }


@app.get("/api/cog/tilejson", summary="TileJSON descriptor for Leaflet")
def get_tilejson(titiler_url: str = "http://localhost:8001"):
    """
    Return a TileJSON object pointing at TiTiler.
    The frontend uses this to configure the Leaflet tile layer.
    """
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    cog_path_uri = Path(OUTPUT_FILE).absolute().as_posix()
    encoded_cog_url = urllib.parse.quote(cog_path_uri, safe="")

    # Get info from TiTiler to get correct min/max zoom
    info_url = f"{titiler_url}/cog/info?url={encoded_cog_url}"
    try:
        response = httpx.get(info_url, timeout=10.0)
        if response.status_code == 200:
            info = response.json()
            minzoom = info.get("minzoom", 5)
            # Override maxzoom to 22 to allow deep dynamic overzooming
            maxzoom = max(info.get("maxzoom", 18), 22)
        else:
            minzoom = 5
            maxzoom = 22
    except:
        minzoom = 5
        maxzoom = 22

    # Build tile URL — TiTiler COG endpoint
    # Use a backend proxy endpoint so the browser does not send raw file:// URLs.
    tile_url = (
        f"http://localhost:8000/api/cog/tiles"
        f"/{{z}}/{{x}}/{{y}}"
    )

    with rasterio.open(OUTPUT_FILE) as src:
        bounds_wgs84 = transform_bounds(
            src.crs, "EPSG:4326", *src.bounds, densify_pts=21
        )
        center_lon = (bounds_wgs84[0] + bounds_wgs84[2]) / 2
        center_lat = (bounds_wgs84[1] + bounds_wgs84[3]) / 2

    return {
        "tilejson": "2.2.0",
        "name":     "EO Platform — Hyderabad COG",
        "tiles":    [tile_url],
        "minzoom":  minzoom,
        "maxzoom":  maxzoom,
        "bounds":   list(bounds_wgs84),
        "center":   [center_lon, center_lat, 10],
    }


@app.get("/api/cog/tiles/{z}/{x}/{y}")
def proxy_cog_tile(z: int, x: int, y: int):
    """Proxy a TiTiler COG tile request through the backend."""
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    titiler_url = "http://localhost:8001"

    # Use a posix path string for TiTiler on Windows.
    cog_path_uri = Path(OUTPUT_FILE).absolute().as_posix()

    # Encode as query param value.
    encoded_cog_url = urllib.parse.quote(cog_path_uri, safe="")

    # Some TiTiler builds support `@1x`, but if yours doesn't, tiles will fail with 500.
    # Use the plain {z}/{x}/{y} style.
    # Use TiTiler render options for RGB float imagery to improve display.
    tile_url = (
        f"{titiler_url}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png"
        f"?url={encoded_cog_url}&rescale=0,1&rgb=1,2,3"
    )


    try:
        response = httpx.get(tile_url, timeout=20.0)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"TiTiler request failed: {exc}")

    if response.status_code != 200:
        # Helpful diagnostics to quickly identify TiTiler-side failures.
        snippet = (response.text or "").strip()[:1000]
        raise HTTPException(
            status_code=response.status_code,
            detail=(
                f"TiTiler tile request failed.\n"
                f"tile_url={tile_url}\n"
                f"status={response.status_code}\n"
                f"response_snippet={snippet}"
            ),
        )


    return Response(
        content=response.content,
        media_type=response.headers.get("Content-Type", "application/octet-stream"),
    )


@app.get("/api/bands", summary="Band statistics")
def get_band_stats():
    """Return per-band statistics for the COG."""
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found.",
        )

    stats = []
    with rasterio.open(OUTPUT_FILE) as src:
        for i in range(1, src.count + 1):
            band = src.read(i)
            stats.append({
                "band":  i,
                "min":   float(band.min()),
                "max":   float(band.max()),
                "mean":  float(band.mean()),
            })
    return {"bands": stats}
