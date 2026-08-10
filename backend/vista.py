import os
import glob
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from fastapi import APIRouter, Request, HTTPException, Response

from pgstac_client import get_db_conn, register_stac_item, search_stac_items, get_stac_item_by_id, get_distinct_filter_values
from minio_client import upload_cog_to_minio

router = APIRouter()
TITILER_PUBLIC_URL = os.environ.get("TITILER_URL", "http://localhost:8001")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VISTA_DATA_DIR = os.path.join(BASE_DIR, "vista_data")

# Helper for XML element extraction
def get_xml_element_text(root, name, default=None):
    for elem in root.iter(name):
        return elem.text
    return default

# Reverse geocoding using Nominatim (uses httpx — already in venv)
def reverse_geocode(lat, lon):
    url = f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&accept-language=en"
    headers = {"User-Agent": "EOPlatform/1.0 (contact: admin@eoplatform.local)"}
    try:
        import httpx
        res = httpx.get(url, headers=headers, timeout=5)
        if res.status_code == 200:
            data = res.json()
            address = data.get("address", {})
            city = address.get("city") or address.get("town") or address.get("village") or address.get("county") or address.get("state_district")
            state = address.get("state")
            country = address.get("country")
            parts = []
            if city: parts.append(city)
            if state: parts.append(state)
            if parts:
                return ", ".join(parts)
            elif country:
                return country
    except Exception as e:
        print(f"Geocoding failed for {lat}, {lon}: {e}")
    return "India"

# Metadata extractor
def extract_safe_metadata(xml_path):
    safe_path = os.path.dirname(xml_path)
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception as e:
        print(f"Failed to parse XML {xml_path}: {e}")
        return None
        
    mission = "Sentinel-2"
    satellite = get_xml_element_text(root, "SPACECRAFT_NAME", "Sentinel-2")
    sensor = get_xml_element_text(root, "SENSOR_ID", "MSI")
    proc_level = get_xml_element_text(root, "PROCESSING_LEVEL", "Level-2A")
    acq_date = get_xml_element_text(root, "PRODUCT_START_TIME", "1970-01-01T00:00:00.000Z")
    proc_date = get_xml_element_text(root, "GENERATION_TIME", acq_date)
    orbit = get_xml_element_text(root, "SENSING_ORBIT_NUMBER", "0")
    
    cc_elem = next(root.iter('Cloud_Coverage_Assessment'), None)
    cloud_cover = float(cc_elem.text) if cc_elem is not None else 100.0
    
    # Tile ID
    tile_id = None
    tile_id_elem = next(root.iter('TILE_ID'), None)
    if tile_id_elem is not None:
        tile_id = tile_id_elem.text
    else:
        granules = glob.glob(os.path.join(safe_path, "GRANULE/*"))
        if granules:
            g_name = os.path.basename(granules[0])
            parts = g_name.split("_")
            for p in parts:
                if len(p) == 6 and p.startswith("T"):
                    tile_id = p
                    break
    if not tile_id:
        tile_id = "Unknown"
        
    product_type = "SAFE"
    
    tci_files = list(Path(safe_path).rglob("*_TCI*.jp2")) + list(Path(safe_path).rglob("*_TCI*.tif"))
    if not tci_files:
        tci_files = list(Path(safe_path).rglob("*.jp2")) + list(Path(safe_path).rglob("*.tif"))
        
    if not tci_files:
        print("No raster files found in", safe_path)
        return None
        
    tci_path = str(tci_files[0])
    import rasterio
    from rasterio.warp import transform_bounds
    
    try:
        with rasterio.open(tci_path) as src:
            crs = src.crs.to_string() if src.crs else "EPSG:32643"
            width = src.width
            height = src.height
            resolution = src.res[0] if src.res else 10.0
            bounds = list(transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21))
    except Exception as e:
        print(f"Failed to read raster metadata from {tci_path}: {e}")
        return None
        
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    
    footprint_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [bounds[0], bounds[1]],
                [bounds[0], bounds[3]],
                [bounds[2], bounds[3]],
                [bounds[2], bounds[1]],
                [bounds[0], bounds[1]]
            ]
        ]
    }
    
    place = reverse_geocode(center_lat, center_lon)
    
    return {
        "mission": mission,
        "satellite": satellite,
        "sensor": sensor,
        "product_type": product_type,
        "processing_level": proc_level,
        "acquisition_date": acq_date,
        "processing_date": proc_date,
        "tile_id": tile_id,
        "orbit": orbit,
        "cloud_cover": cloud_cover,
        "resolution": f"{int(resolution)}m" if resolution else "10m",
        "crs": crs,
        "bbox": bounds,
        "footprint": footprint_poly,
        "width": width,
        "height": height,
        "place": place,
        "original_name": os.path.basename(safe_path),
        "added_time": os.path.getmtime(safe_path)
    }

def extract_landsat_metadata(mtl_path):
    folder_path = os.path.dirname(mtl_path)
    
    mission = "Landsat"
    satellite = "Landsat"
    sensor = "OLI/TIRS"
    proc_level = "Level-1"
    acq_date = "1970-01-01T00:00:00.000Z"
    cloud_cover = 0.0
    tile_id = "Unknown"
    
    # Read MTL text for simple metadata
    try:
        with open(mtl_path, 'r') as f:
            for line in f:
                if "SPACECRAFT_ID" in line:
                    satellite = line.split("=")[1].strip().strip('"')
                elif "SENSOR_ID" in line:
                    sensor = line.split("=")[1].strip().strip('"')
                elif "DATE_ACQUIRED" in line:
                    acq_date = line.split("=")[1].strip() + "T00:00:00Z"
                elif "CLOUD_COVER " in line:
                    cloud_cover = float(line.split("=")[1].strip())
    except:
        pass
        
    tci_files = list(Path(folder_path).rglob("*_B4.tif")) # Red band as fallback
    if not tci_files:
        tci_files = list(Path(folder_path).rglob("*.tif"))
    if not tci_files:
        return None
        
    tci_path = str(tci_files[0])
    import rasterio
    from rasterio.warp import transform_bounds
    try:
        with rasterio.open(tci_path) as src:
            crs = src.crs.to_string() if src.crs else "EPSG:32643"
            width = src.width
            height = src.height
            resolution = src.res[0] if src.res else 30.0
            bounds = list(transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21))
    except:
        return None
        
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    
    footprint_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [bounds[0], bounds[1]],
                [bounds[0], bounds[3]],
                [bounds[2], bounds[3]],
                [bounds[2], bounds[1]],
                [bounds[0], bounds[1]]
            ]
        ]
    }
    
    place = reverse_geocode(center_lat, center_lon)
    
    return {
        "mission": mission,
        "satellite": satellite,
        "sensor": sensor,
        "product_type": "GEOTIFF",
        "processing_level": proc_level,
        "acquisition_date": acq_date,
        "processing_date": acq_date,
        "tile_id": tile_id,
        "orbit": "0",
        "cloud_cover": cloud_cover,
        "resolution": f"{int(resolution)}m",
        "crs": crs,
        "bbox": bounds,
        "footprint": footprint_poly,
        "width": width,
        "height": height,
        "place": place,
        "original_name": os.path.basename(folder_path),
        "added_time": os.path.getmtime(folder_path)
    }

def extract_generic_metadata(tif_path):
    folder_path = os.path.dirname(tif_path)
    import rasterio
    from rasterio.warp import transform_bounds
    try:
        with rasterio.open(tif_path) as src:
            crs = src.crs.to_string() if src.crs else "EPSG:4326"
            width = src.width
            height = src.height
            resolution = src.res[0] if src.res else 10.0
            bounds = list(transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21))
    except:
        return None
        
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    
    footprint_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [bounds[0], bounds[1]],
                [bounds[0], bounds[3]],
                [bounds[2], bounds[3]],
                [bounds[2], bounds[1]],
                [bounds[0], bounds[1]]
            ]
        ]
    }
    
    place = reverse_geocode(center_lat, center_lon)
    
    import datetime
    acq_date = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    
    return {
        "mission": "Generic",
        "satellite": "Unknown",
        "sensor": "Generic Raster",
        "product_type": "GEOTIFF",
        "processing_level": "Unknown",
        "acquisition_date": acq_date,
        "processing_date": acq_date,
        "tile_id": "Unknown",
        "orbit": "0",
        "cloud_cover": 0.0,
        "resolution": f"{int(resolution)}m",
        "crs": crs,
        "bbox": bounds,
        "footprint": footprint_poly,
        "width": width,
        "height": height,
        "place": place,
        "original_name": os.path.basename(folder_path),
        "added_time": os.path.getmtime(tif_path)
    }

def _parse_band_meta(meta_path):
    """Parse ISRO BAND_META.txt / .meta key=value files."""
    meta = {}
    try:
        with open(meta_path, 'r') as f:
            for line in f:
                if '=' in line:
                    k, v = line.split('=', 1)
                    meta[k.strip()] = v.strip()
    except Exception:
        pass
    return meta

def extract_resourcesat2_metadata(meta_path):
    """Extract metadata from Resourcesat-2 BAND_META.txt."""
    folder_path = os.path.dirname(meta_path)
    meta = _parse_band_meta(meta_path)
    
    satellite = meta.get("SatID", "IRS-R2")
    sensor = meta.get("Sensor", "LISS-IV")
    # Map sensor codes to human-readable names
    sensor_names = {"L4FX": "LISS-IV", "L4MX": "LISS-IV-MX", "L3": "LISS-III", "AWFS": "AWiFS"}
    sensor_display = sensor_names.get(sensor, sensor)
    
    path_num = meta.get("Path", "0").strip()
    row_num = meta.get("Row", "0").strip()
    tile_id = f"P{path_num}R{row_num}" if path_num and row_num else "Unknown"
    
    # Parse date
    date_str = meta.get("DateOfPass", "")
    acq_date = "1970-01-01T00:00:00Z"
    if date_str:
        try:
            import datetime
            dt = datetime.datetime.strptime(date_str.strip(), "%d-%b-%Y")
            scene_time = meta.get("SceneCenterTime", "")
            if scene_time:
                time_part = scene_time.strip().split(" ")[-1].split(".")[0]  # HH:MM:SS
                acq_date = f"{dt.strftime('%Y-%m-%d')}T{time_part}Z"
            else:
                acq_date = dt.strftime("%Y-%m-%dT00:00:00Z")
        except Exception:
            pass
    
    proc_level = meta.get("ProdType", meta.get("ProcessingLevel", "STD"))
    orbit = meta.get("ImagingOrbitNo", "0")
    cloud_cover = 0.0
    cp = meta.get("CloudPercent", "").strip()
    if cp:
        try:
            cloud_cover = float(cp)
        except Exception:
            pass
    
    bits_per_pixel = int(meta.get("BitsPerPixel", "10"))
    
    resolution_val = meta.get("OutputResolutionAlong", meta.get("InputResolutionAlong", "5.8"))
    try:
        resolution = float(resolution_val.strip())
    except Exception:
        resolution = 5.8
    
    # Find a band TIF to get CRS/bounds
    band_tifs = list(Path(folder_path).glob("BAND*.tif"))
    if not band_tifs:
        band_tifs = list(Path(folder_path).rglob("*.tif"))
    if not band_tifs:
        return None
    
    import rasterio
    from rasterio.warp import transform_bounds
    try:
        with rasterio.open(str(band_tifs[0])) as src:
            crs = src.crs.to_string() if src.crs else "EPSG:32643"
            width = src.width
            height = src.height
            bounds = list(transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21))
    except Exception:
        return None
    
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    
    footprint_poly = {
        "type": "Polygon",
        "coordinates": [
            [
                [bounds[0], bounds[1]],
                [bounds[0], bounds[3]],
                [bounds[2], bounds[3]],
                [bounds[2], bounds[1]],
                [bounds[0], bounds[1]]
            ]
        ]
    }
    
    place = reverse_geocode(center_lat, center_lon)
    
    return {
        "mission": "Resourcesat-2",
        "satellite": satellite,
        "sensor": sensor_display,
        "product_type": "GEOTIFF",
        "processing_level": proc_level,
        "acquisition_date": acq_date,
        "processing_date": acq_date,
        "tile_id": tile_id,
        "orbit": orbit,
        "cloud_cover": cloud_cover,
        "resolution": f"{int(resolution)}m",
        "crs": crs,
        "bbox": bounds,
        "footprint": footprint_poly,
        "width": width,
        "height": height,
        "place": place,
        "bits_per_pixel": bits_per_pixel,
        "original_name": os.path.basename(folder_path),
        "added_time": os.path.getmtime(folder_path)
    }

# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/images", summary="List images in Vista Mode")
def get_images(request: Request):
    """Returns all images registered in pgSTAC sorted by priority."""
    try:
        items = search_stac_items({})
        
        items.sort(key=lambda x: -float(x["properties"].get("added_time", 0.0)))
        
        results = []
        for item in items:
            image_id = item["id"]
            base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
            stac_url = f"{base_url}/vista/stac/{image_id}"
            tile_url = f"{TITILER_PUBLIC_URL}/stac/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(stac_url)}&resampling=bilinear"
            
            # Determine default assets
            default_assets = ""
            if "tci" in item["assets"]:
                default_assets = "&assets=tci"
            elif all(b in item["assets"] for b in ["band04", "band03", "band02"]):
                default_assets = "&assets=band04&assets=band03&assets=band02&rescale=0,3000"
            elif all(b in item["assets"] for b in ["band4", "band3", "band2"]) and item["properties"].get("mission") == "Resourcesat-2":
                default_assets = "&assets=band4&assets=band3&assets=band2&asset_bidx=band4|1&asset_bidx=band3|1&asset_bidx=band2|1&rescale=0,600"
            elif all(b in item["assets"] for b in ["band4", "band3", "band2"]):
                default_assets = "&assets=band4&assets=band3&assets=band2&rescale=0,30000"
            elif item["assets"]:
                first_band = list(item["assets"].keys())[0]
                default_assets = f"&assets={first_band}&rescale=0,30000"
                
            results.append({
                "name": image_id,
                "cloud_cover": item["properties"].get("cloud_cover", 100.0),
                "acquisition_date": item["properties"].get("acquisition_date", ""),
                "resolution": item["properties"].get("resolution", "10m"),
                "tci_url": tile_url,
                "place": item["properties"].get("place", "India"),
                "default_assets": default_assets
            })
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/filters", summary="Get distinct filter values from pgSTAC")
def get_vista_filters(
    mission: str = None,
    sensor: str = None,
    processing_level: str = None,
    product_type: str = None,
    tile_id: str = None,
    resolution: str = None,
    cloud_cover: str = None,
    place: str = None,
    start_date: str = None,
    end_date: str = None
):
    filters = {
        "mission": mission,
        "sensor": sensor,
        "processing_level": processing_level,
        "product_type": product_type,
        "tile_id": tile_id,
        "resolution": resolution,
        "cloud_cover": cloud_cover,
        "place": place,
        "start_date": start_date,
        "end_date": end_date
    }
    # Remove empty filters
    filters = {k: v for k, v in filters.items() if v}
    try:
        return get_distinct_filter_values(filters)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/search", summary="Search images in pgSTAC and return generated TiTiler URLs")
def search_vista_images(
    request: Request,
    mission: str = None,
    sensor: str = None,
    processing_level: str = None,
    product_type: str = None,
    tile_id: str = None,
    resolution: str = None,
    cloud_cover: str = None,
    place: str = None,
    start_date: str = None,
    end_date: str = None
):
    filters = {
        "mission": mission,
        "sensor": sensor,
        "processing_level": processing_level,
        "product_type": product_type,
        "tile_id": tile_id,
        "resolution": resolution,
        "cloud_cover": cloud_cover,
        "place": place,
        "start_date": start_date,
        "end_date": end_date
    }
    
    try:
        items = search_stac_items(filters)
        
        items.sort(key=lambda x: -float(x["properties"].get("added_time", 0.0)))
        
        results = []
        for item in items:
            image_id = item["id"]
            base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
            stac_url = f"{base_url}/vista/stac/{image_id}"
            tile_url = f"{TITILER_PUBLIC_URL}/stac/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(stac_url)}&resampling=bilinear"
            
            # Determine default assets
            default_assets = ""
            if "tci" in item["assets"]:
                default_assets = "&assets=tci"
            elif all(b in item["assets"] for b in ["band04", "band03", "band02"]):
                default_assets = "&assets=band04&assets=band03&assets=band02&rescale=0,3000"
            elif all(b in item["assets"] for b in ["band4", "band3", "band2"]) and item["properties"].get("mission") == "Resourcesat-2":
                default_assets = "&assets=band4&assets=band3&assets=band2&asset_bidx=band4|1&asset_bidx=band3|1&asset_bidx=band2|1&rescale=0,600"
            elif all(b in item["assets"] for b in ["band4", "band3", "band2"]):
                default_assets = "&assets=band4&assets=band3&assets=band2&rescale=0,30000"
            elif item["assets"]:
                first_band = list(item["assets"].keys())[0]
                default_assets = f"&assets={first_band}&rescale=0,30000"

            results.append({
                "name": image_id,
                "tile_url": tile_url,
                "bbox": item["bbox"],
                "footprint": item["geometry"],
                "metadata": item["properties"],
                "default_assets": default_assets,
                "assets": item.get("assets", {})
            })
            
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.api_route("/stac/{image_name}", methods=["GET", "HEAD"], summary="STAC Item for a Vista Image from pgSTAC")
def get_vista_stac_item(image_name: str, request: Request):
    safe_name = os.path.basename(image_name)
    item = get_stac_item_by_id(safe_name)
    if not item:
        raise HTTPException(status_code=404, detail="Image not found in pgSTAC")
    if request.method == "HEAD":
        return Response(status_code=200, media_type="application/json")
    return item

@router.get("/view/{image_name}", summary="TileJSON for Vista Image")
def view_vista_image(image_name: str, request: Request, expression: str = None, assets: str = None, colormap_name: str = None, asset_as_band: bool = None, rescale: str = None, zarr_index: str = None):
    safe_name = os.path.basename(image_name)
    item = get_stac_item_by_id(safe_name)
    if not item:
        raise HTTPException(status_code=404, detail="Image not found in pgSTAC")
        
    bounds = item["bbox"]
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2

    if zarr_index == "NDVI":
        expression = "(b1-b2)/(b1+b2)"
        assets = "band08,band04"
        asset_as_band = True
        colormap_name = "rdylgn"
        rescale = "-1,1"
    elif zarr_index == "NDWI":
        expression = "(b1-b2)/(b1+b2)"
        assets = "band03,band08"
        asset_as_band = True
        colormap_name = "rdylgn"
        rescale = "-1,1"

    base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
    stac_url = f"{base_url}/vista/stac/{safe_name}"
    tile_url = f"{TITILER_PUBLIC_URL}/stac/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?url={urllib.parse.quote(stac_url)}&resampling=bilinear"
    
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
        if "tci" in item["assets"]:
            tile_url += "&assets=tci"
        elif all(b in item["assets"] for b in ["band04", "band03", "band02"]):
            tile_url += "&assets=band04&assets=band03&assets=band02&color_formula=Gamma+RGB+3.5+Saturation+1.7"
        else:
            first_band = list(item["assets"].keys())[0]
            tile_url += f"&assets={first_band}"
        
    if colormap_name:
        tile_url += f"&colormap_name={colormap_name}"
        
    if rescale:
        tile_url += f"&rescale={rescale}"
    else:
        if not colormap_name and assets and "tci" not in assets:
            tile_url += "&rescale=0,3000"
        if expression and not colormap_name:
            tile_url += "&rescale=-1,1"
            
    return {
        "tilejson": "2.2.0",
        "name": item["id"],
        "tiles": [tile_url],
        "minzoom": 1,
        "maxzoom": 24,
        "bounds": bounds,
        "center": [center_lon, center_lat, 10],
    }

@router.get("/info/{image_name}", summary="Metadata for Vista Image")
def get_vista_image_info(image_name: str, request: Request):
    safe_name = os.path.basename(image_name)
    item = get_stac_item_by_id(safe_name)
    if not item:
        raise HTTPException(status_code=404, detail="Image not found in pgSTAC")
        
    bounds = item["bbox"]
    center_lon = (bounds[0] + bounds[2]) / 2
    center_lat = (bounds[1] + bounds[3]) / 2
    
    band_list = ", ".join(sorted(item["assets"].keys()))
    
    return {
        "file": item["id"],
        "original_name": item["properties"].get("original_name", item["id"]),
        "bands": band_list,
        "resolution": item["properties"].get("resolution", "10m"),
        "bounds_wgs84": {
            "west": bounds[0],
            "south": bounds[1],
            "east": bounds[2],
            "north": bounds[3],
        },
        "center": {"lat": center_lat, "lon": center_lon},
        "cog_path": f"s3://eo-platform/Sentinel2/{item['id']}/tci.tif",
        "created_at": item["properties"].get("acquisition_date", "")
    }

# ── Background Task ───────────────────────────────────────────────────────────

vista_status = {
    "converting": False,
    "message": "Idle",
    "progress": 0
}

def process_dataset(folder_path, image_name, data_type, metadata_file):
    import time
    from rio_cogeo.cogeo import cog_translate
    from rio_cogeo.profiles import cog_profiles
    
    # Check if already in pgSTAC
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pgstac.items WHERE id = %s;", (image_name,))
            already_registered = cur.fetchone() is not None
        conn.close()
    except Exception as db_err:
        print(f"Vista Scanner: DB query error: {db_err}")
        already_registered = False
        
    if already_registered:
        return False
        
    vista_status["converting"] = True
    vista_status["message"] = f"Converting {image_name} ({data_type})..."
    print(f"Vista Scanner: Found new {data_type} dataset {image_name}. Processing...")
    
    if data_type == "Sentinel-2":
        metadata = extract_safe_metadata(metadata_file)
    elif data_type == "Landsat":
        metadata = extract_landsat_metadata(metadata_file)
    elif data_type == "Resourcesat-2":
        metadata = extract_resourcesat2_metadata(metadata_file)
    else:
        metadata = extract_generic_metadata(metadata_file)
        
    if not metadata:
        print(f"Vista Scanner: Failed to extract metadata for {image_name}")
        return False
        
    if data_type == "Sentinel-2":
        band_suffixes = [
            "_B01_60m.jp2", "_B01.jp2", "_B01_60m.tif", "_B01.tif",
            "_B02_10m.jp2", "_B02.jp2", "_B02_10m.tif", "_B02.tif",
            "_B03_10m.jp2", "_B03.jp2", "_B03_10m.tif", "_B03.tif",
            "_B04_10m.jp2", "_B04.jp2", "_B04_10m.tif", "_B04.tif",
            "_B05_20m.jp2", "_B05.jp2", "_B05_20m.tif", "_B05.tif",
            "_B06_20m.jp2", "_B06.jp2", "_B06_20m.tif", "_B06.tif",
            "_B07_20m.jp2", "_B07.jp2", "_B07_20m.tif", "_B07.tif",
            "_B08_10m.jp2", "_B08.jp2", "_B08_10m.tif", "_B08.tif",
            "_B8A_20m.jp2", "_B8A.jp2", "_B8A_20m.tif", "_B8A.tif",
            "_B09_60m.jp2", "_B09.jp2", "_B09_60m.tif", "_B09.tif",
            "_B11_20m.jp2", "_B11.jp2", "_B11_20m.tif", "_B11.tif",
            "_B12_20m.jp2", "_B12.jp2", "_B12_20m.tif", "_B12.tif",
            "_TCI_10m.jp2", "_TCI_20m.jp2", "_TCI_60m.jp2", "_TCI.jp2",
            "_TCI_10m.tif", "_TCI_20m.tif", "_TCI_60m.tif", "_TCI.tif"
        ]
        prefix_map = {
            "B01": "band01", "B02": "band02", "B03": "band03", "B04": "band04", 
            "B05": "band05", "B06": "band06", "B07": "band07", "B08": "band08", 
            "B8A": "band8A", "B09": "band09", "B11": "band11", "B12": "band12", 
            "TCI": "tci"
        }
    elif data_type == "Landsat":
        band_suffixes = ["_B1.tif", "_B2.tif", "_B3.tif", "_B4.tif", "_B5.tif", "_B6.tif", "_B7.tif", "_B8.tif", "_B9.tif", "_B10.tif", "_B11.tif"]
        prefix_map = {
            "B1": "band1", "B2": "band2", "B3": "band3", "B4": "band4", "B5": "band5", 
            "B6": "band6", "B7": "band7", "B8": "band8", "B9": "band9", "B10": "band10", "B11": "band11"
        }
    elif data_type == "Resourcesat-2":
        # Resourcesat-2 LISS-III/IV bands: BAND2 (Green), BAND3 (Red), BAND4 (NIR), BAND5 (SWIR)
        band_suffixes = ["BAND2.tif", "BAND3.tif", "BAND4.tif", "BAND5.tif"]
        prefix_map = {
            "BAND2": "band2", "BAND3": "band3", "BAND4": "band4", "BAND5": "band5"
        }
    else:
        # Generic raster, just grab the file itself
        band_suffixes = [os.path.basename(metadata_file)]
        prefix_map = {os.path.basename(metadata_file).split(".")[0]: "band1"}
        
    found_files = []
    path_obj = Path(folder_path)
    for suffix in band_suffixes:
        found_files.extend(list(path_obj.rglob(f"*{suffix}")))
    found_files = list(set(found_files))
    
    # Exclude mask files and files outside IMG_DATA directories for Sentinel
    if data_type == "Sentinel-2":
        EXCLUDED_DIRS = {"QI_DATA", "DATASTRIP", "AUXILIARY_DATA"}
        EXCLUDED_PREFIXES = ("MSK_",)
        def is_valid_band_file(p: Path) -> bool:
            parts = set(p.parts)
            if any(d in parts for d in EXCLUDED_DIRS):
                return False
            if p.name.startswith(EXCLUDED_PREFIXES):
                return False
            return True
        found_files = [f for f in found_files if is_valid_band_file(f)]

    total_files = len(found_files)
    processed_count = 0
    
    cog_files = {}
    for band_file in found_files:
        file_str = str(band_file)
        
        band_key = None
        b_name = os.path.basename(file_str)
        
        for prefix, mapped_key in prefix_map.items():
            if prefix in b_name:
                band_key = mapped_key
                break
                
        if not band_key and data_type == "Generic":
            band_key = "band1"
            
        if not band_key:
            processed_count += 1
            continue
            
        pct = int((processed_count / total_files) * 100)
        vista_status["progress"] = pct
        vista_status["message"] = f"Converting {image_name} ({data_type})... {pct}%"
            
        # If file is JP2 or TIFF, convert to COG TIFF
        cog_path = file_str
        lower_file = file_str.lower()
        if lower_file.endswith(".jp2") or lower_file.endswith(".tif") or lower_file.endswith(".tiff"):
            # Ensure it is a COG
            if lower_file.endswith(".jp2") or lower_file.endswith(".tif"):
                cog_path = file_str[:-4] + "_cog.tif"
            else:
                cog_path = file_str[:-5] + "_cog.tif"
                
            if not os.path.exists(cog_path):
                print(f"Vista Scanner: Converting {os.path.basename(file_str)} -> COG TIFF...")
                t0 = time.time()
                try:
                    profile = cog_profiles.get("deflate")
                    profile.update(blockxsize=256, blockysize=256)
                    config = {"GDAL_TIFF_INTERNAL_MASK": True, "GDAL_TIFF_OVR_BLOCKSIZE": 256}
                    cog_translate(
                        file_str, 
                        cog_path, 
                        profile, 
                        config=config, 
                        nodata=0,
                        in_memory=False, 
                        quiet=True,
                        overview_level=6,
                        overview_resampling="bilinear"
                    )
                    print(f"Vista Scanner: Converted in {time.time() - t0:.2f} seconds.")
                except Exception as ex:
                    print(f"Vista Scanner: Failed to convert: {ex}")
                    processed_count += 1
                    continue
                    
        # Upload to MinIO
        try:
            s3_path = upload_cog_to_minio(cog_path, image_name, band_key)
            cog_files[band_key] = s3_path
        except Exception as ex:
            print(f"Vista Scanner: Failed uploading to MinIO: {ex}")
            processed_count += 1
            continue
            
        processed_count += 1
            
    if not cog_files:
        print(f"Vista Scanner: No bands successfully processed for {image_name}")
        return False
        
    # Create STAC Item
    metadata["datetime"] = metadata.get("acquisition_date")
    if not metadata["datetime"]:
        metadata["datetime"] = "1970-01-01T00:00:00.000Z"
        
    collection_name = metadata.get("mission", "Generic")
    if collection_name == "Sentinel-2":
        collection_name = "Sentinel2"
    
    stac_item = {
        "id": image_name,
        "type": "Feature",
        "stac_version": "1.0.0",
        "collection": collection_name,
        "geometry": metadata["footprint"],
        "bbox": metadata["bbox"],
        "properties": metadata,
        "assets": {},
        "links": []
    }
    
    for band_key, s3_path in cog_files.items():
        stac_item["assets"][band_key] = {
            "href": s3_path,
            "type": "image/tiff; application=geotiff; profile=cloud-optimized",
            "roles": ["data"]
        }
        
    try:
        register_stac_item(stac_item)
        print(f"Vista Scanner: Successfully processed & registered {image_name}.")
        return True
    except Exception as e:
        print(f"Vista Scanner: Error registering in pgSTAC: {e}")
        return False

def convert_vista_jp2_to_cogs():
    """Background task to continuously scan vista_data, convert data to COGs, upload to MinIO, and register in pgSTAC."""
    import time
    
    print("Vista pgSTAC/MinIO background thread started (Multi-Mission Enabled)...")
    
    while True:
        try:
            processing_occurred = False
            
            # 1. Sentinel-2
            xml_files = glob.glob(os.path.join(VISTA_DATA_DIR, "**", "MTD_MSIL*.xml"), recursive=True)
            for xml_path in xml_files:
                folder_path = os.path.dirname(xml_path)
                image_name = os.path.basename(folder_path)
                if process_dataset(folder_path, image_name, "Sentinel-2", xml_path):
                    processing_occurred = True
                    
            # 2. Landsat 8/9
            mtl_files = glob.glob(os.path.join(VISTA_DATA_DIR, "**", "*_MTL.txt"), recursive=True)
            for mtl_path in mtl_files:
                folder_path = os.path.dirname(mtl_path)
                image_name = os.path.basename(folder_path)
                if process_dataset(folder_path, image_name, "Landsat", mtl_path):
                    processing_occurred = True
                    
            # 3. Resourcesat-2 (ISRO — detected by BAND_META.txt)
            band_meta_files = glob.glob(os.path.join(VISTA_DATA_DIR, "**", "BAND_META.txt"), recursive=True)
            for bm_path in band_meta_files:
                folder_path = os.path.dirname(bm_path)
                image_name = os.path.basename(folder_path)
                if process_dataset(folder_path, image_name, "Resourcesat-2", bm_path):
                    processing_occurred = True
                    
            # 4. Generic TIFFs (Direct files in subfolders that aren't Sentinel, Landsat, or Resourcesat)
            if os.path.exists(VISTA_DATA_DIR):
                for item in os.listdir(VISTA_DATA_DIR):
                    sub_path = os.path.join(VISTA_DATA_DIR, item)
                    if os.path.isdir(sub_path):
                        is_known = False
                        if (list(Path(sub_path).rglob("MTD_MSIL*.xml")) or 
                            list(Path(sub_path).rglob("*_MTL.txt")) or
                            list(Path(sub_path).rglob("BAND_META.txt"))):
                            is_known = True
                        if not is_known:
                            tifs = list(Path(sub_path).rglob("*.tif"))
                            if tifs:
                                if process_dataset(sub_path, item, "Generic", str(tifs[0])):
                                    processing_occurred = True

            if processing_occurred:
                vista_status["converting"] = False
                vista_status["message"] = "Conversion is over"
                
        except Exception as e:
            print(f"Vista Scanner: Error in background loop: {e}")
            
        time.sleep(10)

def start_vista_conversion_thread():
    import threading
    thread = threading.Thread(target=convert_vista_jp2_to_cogs, daemon=True)
    thread.start()
    return thread
