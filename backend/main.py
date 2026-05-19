

import os
import json
import subprocess
import sys
import urllib.parse

import rasterio
import numpy as np
from rasterio.warp import transform_bounds
from rasterio.enums import Resampling
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse, Response
import httpx

# Default to the deployed eo-titiler service so Render deployments work without manual env vars.
TITILER_URL = os.getenv("TITILER_URL", "https://eo-titiler.onrender.com")

from processing import (
    convert_to_cog,
    start_processing_thread,
    processing_status,
    OUTPUT_FILE,
    INPUT_FILE,
    DATA_DIR,
    BASE_DIR,
)

from io import BytesIO
from PIL import Image

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="EO Platform API",
    description="Earth Observation Satellite Image Visualization Backend",
    version="1.0.0",
)


# Automatically start COG conversion on service startup if input.tif exists but output_cog.tif is missing.
@app.on_event("startup")
def ensure_cog_on_startup():
    try:
        # If input TIFF exists and output COG doesn't, start processing in background
        if os.path.exists(INPUT_FILE) and not os.path.exists(OUTPUT_FILE):
            # Use the thread helper to avoid blocking startup
            start_processing_thread()
    except Exception:
        # Do not raise — we want the service to start even if processing fails
        pass

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


@app.get("/api/titiler/health", summary="TiTiler health check")
def titiler_health():
    try:
        response = httpx.get(f"{TITILER_URL}/healthz", timeout=30.0)
        return {
            "ok": response.status_code == 200,
            "status_code": response.status_code,
        }
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"TiTiler health check failed: {exc}")




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


@app.get("/api/cog/raw", summary="Download raw COG file")
def get_raw_cog():
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )
    return FileResponse(OUTPUT_FILE, media_type="image/tiff")


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
def get_tilejson(request: Request, titiler_url: str = TITILER_URL):
    """
    Return a TileJSON object pointing at TiTiler.
    The frontend uses this to configure the Leaflet tile layer.
    """
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    source_url = str(request.base_url) + "api/cog/raw"
    encoded_cog_url = urllib.parse.quote(source_url, safe="")

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
    tile_url = "/api/cog/tiles/{z}/{x}/{y}"

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


@app.get("/api/input/info", summary="Input TIFF metadata")
def get_input_info():
    """Return spatial metadata about the input GeoTIFF (before conversion)."""
    if not os.path.exists(INPUT_FILE):
        raise HTTPException(status_code=404, detail="Input file not found.")

    with rasterio.open(INPUT_FILE) as src:
        bounds_wgs84 = transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
        center_lon = (bounds_wgs84[0] + bounds_wgs84[2]) / 2
        center_lat = (bounds_wgs84[1] + bounds_wgs84[3]) / 2

        return {
            "file": os.path.basename(INPUT_FILE),
            "size_mb": round(os.path.getsize(INPUT_FILE) / 1_048_576, 2),
            "width": src.width,
            "height": src.height,
            "bands": src.count,
            "crs": str(src.crs),
            "bounds_wgs84": list(bounds_wgs84),
            "center": {"lat": center_lat, "lon": center_lon},
        }


@app.get("/api/input/preview", summary="PNG preview of input TIFF")
def get_input_preview(max_size: int = 1024):
    """Return a PNG preview (downsampled) of the input GeoTIFF for quick display in the frontend.

    max_size controls the maximum dimension (width or height) of the returned image.
    """
    if not os.path.exists(INPUT_FILE):
        raise HTTPException(status_code=404, detail="Input file not found.")

    try:
        with rasterio.open(INPUT_FILE) as src:
            # Read a downsampled overview if available or resample to fit max_size
            w, h = src.width, src.height
            scale = max(1, int(max(w / max_size, h / max_size)))

            # Use rio's read with out_shape to resample
            out_shape = (src.count, int(h / scale), int(w / scale))
            data = src.read(
                out_shape=out_shape,
                resampling=Resampling.nearest,
            )

            # Convert to uint8 image (RGB)
            # data shape: (bands, H, W)
            arr = data.astype('float32')
            # Simple linear stretch per-band
            for i in range(arr.shape[0]):
                band = arr[i]
                mn, mx = band.min(), band.max()
                if mx > mn:
                    arr[i] = (band - mn) / (mx - mn) * 255.0
                else:
                    arr[i] = band * 0

            # Stack into HxWx3 (use first 3 bands or replicate)
            H = arr.shape[1]
            W = arr.shape[2]
            if arr.shape[0] >= 3:
                img = np.dstack([arr[0], arr[1], arr[2]]).astype('uint8')
            else:
                gray = arr[0].astype('uint8')
                img = np.dstack([gray, gray, gray])

            pil = Image.fromarray(img)
            buf = BytesIO()
            pil.save(buf, format='PNG')
            buf.seek(0)

            return Response(content=buf.read(), media_type='image/png')

    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Preview generation failed: {exc}")


@app.get("/api/cog/tiles/{z}/{x}/{y}")
def proxy_cog_tile(request: Request, z: int, x: int, y: int):
    """Proxy a TiTiler COG tile request through the backend."""
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    titiler_url = TITILER_URL

    # TiTiler reads the publicly exposed COG file from the backend service.
    source_url = str(request.base_url) + "api/cog/raw"
    encoded_cog_url = urllib.parse.quote(source_url, safe="")

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


@app.get("/api/debug/tile_check", summary="Debug: fetch a sample tile from TiTiler")
def debug_tile_check(request: Request, z: int = 1, x: int = 0, y: int = 0):
    """Attempt to fetch a tile from TiTiler and return diagnostics useful for debugging deployments.

    Returns JSON with the resolved `tile_url`, HTTP status code, response content length and content-type.
    """
    if not os.path.exists(OUTPUT_FILE):
        raise HTTPException(
            status_code=404,
            detail="COG file not found. Run POST /api/process first.",
        )

    # Read runtime env var in case Render sets it after process start
    titiler_url = os.getenv("TITILER_URL", TITILER_URL)

    source_url = str(request.base_url) + "api/cog/raw"
    encoded_cog_url = urllib.parse.quote(source_url, safe="")

    tile_url = (
        f"{titiler_url}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png"
        f"?url={encoded_cog_url}&rescale=0,1&rgb=1,2,3"
    )

    try:
        resp = httpx.get(tile_url, timeout=20.0)
    except httpx.RequestError as exc:
        return JSONResponse(status_code=502, content={
            "error": "request_failed",
            "message": str(exc),
            "tile_url": tile_url,
        })

    content_snippet = None
    try:
        # return a short hexdump for binary safety
        content_snippet = resp.content[:200].hex()
    except Exception:
        content_snippet = None

    return JSONResponse(content={
        "tile_url": tile_url,
        "status_code": resp.status_code,
        "content_length": len(resp.content) if resp.content is not None else 0,
        "content_type": resp.headers.get("Content-Type"),
        "snippet_hex": content_snippet,
    })
