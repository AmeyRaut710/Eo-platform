import os
import json
import urllib.parse
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
import httpx

from processing import start_processing_thread, processing_status, BASE_DIR
from db import init_db, get_all_images, get_image_by_id
from vista import router as vista_router, start_vista_conversion_thread, get_db_conn, vista_status

# Public URL for TiTiler so the frontend can reach it directly
TITILER_PUBLIC_URL = os.environ.get("TITILER_URL", "http://localhost:8001")
# Internal URL for FastAPI to reach TiTiler if needed
TITILER_INTERNAL_URL = os.environ.get("TITILER_INTERNAL_URL", "http://titiler:8000")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    import anyio
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = 1000
    
    # Initialize MinIO and pgSTAC
    from minio_client import init_minio
    from pgstac_client import init_pgstac
    init_minio()
    init_pgstac()
    
    init_db()
    start_processing_thread()
    start_vista_conversion_thread()
    yield
    # Shutdown
    pass

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="EO Platform API",
    description="Earth Observation Satellite Image Visualization Backend",
    version="2.0.0",
    lifespan=lifespan
)

# ── CORS (allow all origins for local dev) ────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static files (serve frontend and data) ──────────────────────────────────
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

VISTA_DATA_DIR = os.path.join(BASE_DIR, "vista_data")
if os.path.exists(VISTA_DATA_DIR):
    app.mount("/vista_data", StaticFiles(directory=VISTA_DATA_DIR), name="vista_data")

# Custom endpoint to serve COGs with HTTP Range request support
@app.api_route("/app/cogs/{file_name}", methods=["GET", "HEAD"])
def get_cog_file(file_name: str, request: Request):
    file_path = os.path.join(BASE_DIR, "cogs", file_name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    file_size = os.path.getsize(file_path)
    
    # Handle HEAD request
    if request.method == "HEAD":
        return Response(
            status_code=200,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Content-Type": "image/tiff",
            }
        )
        
    range_header = request.headers.get("range")
    if range_header:
        try:
            h_range = range_header.replace("bytes=", "").split("-")
            start = int(h_range[0])
            end = int(h_range[1]) if h_range[1] else file_size - 1
            if start >= file_size or end >= file_size or start > end:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
            
            chunk_size = end - start + 1
            
            def file_iterator():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    bytes_to_read = chunk_size
                    while bytes_to_read > 0:
                        chunk = f.read(min(bytes_to_read, 65536))
                        if not chunk:
                            break
                        bytes_to_read -= len(chunk)
                        yield chunk
            
            headers = {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
                "Content-Type": "image/tiff",
            }
            return StreamingResponse(file_iterator(), status_code=206, headers=headers)
        except Exception:
            pass
            
    return FileResponse(file_path, media_type="image/tiff")

@app.api_route("/app/vista_data/{file_path:path}", methods=["GET", "HEAD"])
def get_vista_file(file_path: str, request: Request):
    # Prevent directory traversal
    safe_path = os.path.normpath(file_path)
    if safe_path.startswith("..") or os.path.isabs(safe_path):
        raise HTTPException(status_code=400, detail="Invalid path")
        
    full_path = os.path.join(BASE_DIR, "vista_data", safe_path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    file_size = os.path.getsize(full_path)
    
    # Guess media type
    media_type = "application/octet-stream"
    if full_path.endswith(".tif") or full_path.endswith(".tiff"):
        media_type = "image/tiff"
    elif full_path.endswith(".jp2"):
        media_type = "image/jp2"
        
    # Handle HEAD request
    if request.method == "HEAD":
        return Response(
            status_code=200,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Content-Type": media_type,
            }
        )
        
    range_header = request.headers.get("range")
    if range_header:
        try:
            h_range = range_header.replace("bytes=", "").split("-")
            start = int(h_range[0])
            end = int(h_range[1]) if h_range[1] else file_size - 1
            if start >= file_size or end >= file_size or start > end:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
            
            chunk_size = end - start + 1
            
            def file_iterator():
                with open(full_path, "rb") as f:
                    f.seek(start)
                    bytes_to_read = chunk_size
                    while bytes_to_read > 0:
                        chunk = f.read(min(bytes_to_read, 65536))
                        if not chunk:
                            break
                        bytes_to_read -= len(chunk)
                        yield chunk
            
            headers = {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
                "Content-Type": media_type,
            }
            return StreamingResponse(file_iterator(), status_code=206, headers=headers)
        except Exception:
            pass
            
    return FileResponse(full_path, media_type=media_type)

app.include_router(vista_router, prefix="/vista")

# ══════════════════════════════════════════════════════════════════════════════
# Routes
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health", summary="Health check")
def health():
    return {"status": "running"}

@app.get("/", summary="Frontend")
def index():
    """Serve the frontend UI so the whole app runs with a single backend start."""
    index_path = os.path.join(os.path.dirname(BASE_DIR), "frontend", "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(index_path)

@app.get("/datasets", summary="List available satellite images")
def get_datasets():
    """Fetch all available processed satellite images from DB."""
    images = get_all_images()
    return [{
        "id": img["image_id"],
        "name": img["display_name"],
        "original_name": img["original_name"],
        "cog_path": img["cog_path"],
        "created_at": str(img["created_at"])
    } for img in images]

@app.api_route("/api/stac/{image_id}", methods=["GET", "HEAD"], summary="Dynamic STAC Item for a Dataset")
def get_stac_item(image_id: int, request: Request):
    """Generate a valid STAC Item dynamically, pointing to local paths."""
    img = get_image_by_id(image_id)
    if not img or not img.get("cog_path"):
        raise HTTPException(status_code=404, detail="Image not found or not processed")

    # If it is a HEAD request, just verify existence and return 200
    if request.method == "HEAD":
        return Response(status_code=200, media_type="application/json")

    bounds = json.loads(img["bbox"]) if img.get("bbox") else [-180, -90, 180, 90]
    
    stac_item = {
        "stac_version": "1.0.0",
        "stac_extensions": [],
        "type": "Feature",
        "id": img["display_name"],
        "bbox": bounds,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]]]
        },
        "properties": {
            "datetime": str(img.get("created_at") or "2026-06-17T00:00:00Z")
        },
        "links": [],
        "assets": {}
    }

    # If it's a SAFE directory with multiple bands
    if img.get("bands_json"):
        try:
            bands_dict = json.loads(img["bands_json"])
            for band_name, local_path in bands_dict.items():
                stac_item["assets"][band_name] = {
                    "href": local_path,
                    "type": "image/jp2" if local_path.endswith(".jp2") else "image/tiff; application=geotiff; profile=cloud-optimized",
                    "roles": ["data"]
                }
        except Exception:
            pass
            
    # Always include the main COG as a fallback or if it's a single TIF
    if "data" not in stac_item["assets"]:
        stac_item["assets"]["data"] = {
            "href": img["cog_path"],
            "type": "image/tiff; application=geotiff; profile=cloud-optimized",
            "roles": ["data"]
        }
        
    return stac_item

@app.get("/view/{image_id}", summary="TileJSON for specific COG or STAC")
def view_dataset(image_id: int, request: Request, expression: str = None, assets: str = None, colormap_name: str = None, asset_as_band: bool = None, rescale: str = None, zarr_index: str = None):
    """Return a TileJSON object pointing directly to TiTiler's endpoints."""
    img = get_image_by_id(image_id)
    if not img or not img.get("cog_path"):
        raise HTTPException(status_code=404, detail="Image not found or not processed")

    bounds = json.loads(img["bbox"]) if img.get("bbox") else [-180, -90, 180, 90]
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2

    is_multi_band = bool(img.get("bands_json"))

    if zarr_index:
        # We calculated via Zarr but exported to COG for easy serving
        cog_url = f"/app/cogs/{img['display_name']}_{zarr_index}.tif"
        base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
        cog_url = f"{base_url}{cog_url}"
        tile_url = f"{TITILER_PUBLIC_URL}/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(cog_url)}"
    elif is_multi_band:
        # Construct dynamic STAC URL for TiTiler to parse
        base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
        stac_url = f"{base_url}/api/stac/{image_id}"
        tile_url = f"{TITILER_PUBLIC_URL}/stac/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(stac_url)}"
        
        if expression:
            tile_url += f"&expression={urllib.parse.quote(expression)}"
            if asset_as_band:
                tile_url += "&asset_as_band=true"
            if assets:
                for ast in assets.split(","):
                    tile_url += f"&assets={ast}"
        elif assets:
            for ast in assets.split(","):
                tile_url += f"&assets={ast}"
        else:
            if img.get("bands_json") and "TCI" in json.loads(img["bands_json"]):
                tile_url += "&assets=TCI"
            else:
                tile_url += "&assets=data"
    else:
        # Direct COG rendering
        cog_url = img["cog_path"]
        if cog_url.startswith("/app/"):
            base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
            cog_url = f"{base_url}{cog_url}"
        tile_url = f"{TITILER_PUBLIC_URL}/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(cog_url)}"
        
        if expression:
            tile_url += f"&expression={urllib.parse.quote(expression)}"
            
    if colormap_name:
        tile_url += f"&colormap_name={colormap_name}"
        
    if rescale:
        tile_url += f"&rescale={rescale}"
    else:
        # Sentinel-2 rescale fallback if not using colormaps or TCI
        if not colormap_name and assets and "TCI" not in assets:
            tile_url += "&rescale=0,3000"
        if (expression or zarr_index) and not colormap_name:
            tile_url += "&rescale=-1,1" # Default rescale for indices like NDVI

    return {
        "tilejson": "2.2.0",
        "name": img["display_name"],
        "tiles": [tile_url],
        "minzoom": 1,
        "maxzoom": 24,
        "bounds": bounds,
        "center": [center_lon, center_lat, 10],
    }

@app.get("/api/info/{image_id}", summary="COG file metadata")
def get_cog_info(image_id: int):
    """Return metadata for the specific image from DB."""
    img = get_image_by_id(image_id)
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    bounds = json.loads(img["bbox"]) if img.get("bbox") else [-180, -90, 180, 90]
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2

    return {
        "file": img["display_name"],
        "original_name": img["original_name"],
        "bands": img["bands"],
        "resolution": img["resolution"],
        "bounds_wgs84": {
            "west": bounds[0],
            "south": bounds[1],
            "east": bounds[2],
            "north": bounds[3],
        },
        "center": {"lat": center_lat, "lon": center_lon},
        "cog_path": img["cog_path"],
        "created_at": str(img["created_at"])
    }

@app.get("/api/status", summary="COG conversion status")
def get_status():
    """Return current status of the background TIFF → COG conversion thread."""
    return processing_status

@app.get("/vista/status", summary="Vista COG conversion status")
def get_vista_status_api():
    """Return current status of the Vista background conversion thread."""
    return vista_status
