"""
processing.py
=============
Continuously scans backend/data for GeoTIFFs, converts to COG,
and stores metadata.
"""

import os
import time
import json
import logging
import threading
from pathlib import Path

import rasterio
from rasterio.warp import transform_bounds
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles
import xarray as xr
import rioxarray
from db import is_image_processed, reserve_image, update_image, get_image_by_name
from minio_client import upload_cog_to_minio

# ── Configuration ─────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.join(BASE_DIR, "data")
COGS_DIR    = os.path.join(BASE_DIR, "cogs") # Folder for generated COGs

# Ensure COGS_DIR exists
os.makedirs(COGS_DIR, exist_ok=True)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("processing")

processing_status = {
    "running":   True,
    "done":      False,
    "error":     None,
    "progress":  100,
    "message":   "Scanning for new images...",
}

def calculate_raster_index(band1_path, band2_path, out_cog_path, formula_type):
    import numpy as np
    import rasterio
    from rio_cogeo.cogeo import cog_translate
    from rio_cogeo.profiles import cog_profiles
    
    # Path for temporary un-optimized GeoTIFF
    temp_tif_path = out_cog_path + ".tmp.tif"
    
    try:
        log.info(f"Opening bands for index calculation: {os.path.basename(band1_path)} and {os.path.basename(band2_path)}")
        with rasterio.open(band1_path) as src1, rasterio.open(band2_path) as src2:
            profile = src1.profile.copy()
            profile.update(
                dtype=rasterio.float32,
                count=1,
                driver="GTiff",
                compress="lzw"
            )
            
            with rasterio.open(temp_tif_path, "w", **profile) as dst:
                # Process in 512x512 windows to minimize memory footprint
                for _, window in src1.block_windows(1):
                    b1 = src1.read(1, window=window).astype(np.float32)
                    b2 = src2.read(1, window=window).astype(np.float32)
                    
                    denominator = b1 + b2
                    denominator[denominator == 0] = np.nan
                    
                    if formula_type == "ndvi":
                        result = (b1 - b2) / denominator
                    elif formula_type == "ndwi":
                        result = (b1 - b2) / denominator
                        
                    dst.write(result, 1, window=window)
        
        # Translate the temporary TIFF to a proper COG
        cog_profile = cog_profiles.get("deflate")
        cog_profile.update(blockxsize=512, blockysize=512)
        log.info(f"Converting index output to COG: {os.path.basename(out_cog_path)}")
        cog_translate(temp_tif_path, out_cog_path, cog_profile, quiet=True, overview_level=6, overview_resampling="bilinear")
        log.info(f"Successfully calculated and saved index COG to {out_cog_path}")
        
    finally:
        # Clean up temporary TIFF
        if os.path.exists(temp_tif_path):
            try:
                os.remove(temp_tif_path)
            except Exception:
                pass

def calculate_indices(display_name, cogs_dir):
    try:
        b04_path = os.path.join(cogs_dir, f"{display_name}_B04.tif")
        b08_path = os.path.join(cogs_dir, f"{display_name}_B08.tif")
        b03_path = os.path.join(cogs_dir, f"{display_name}_B03.tif")
        
        # NDVI
        if os.path.exists(b04_path) and os.path.exists(b08_path):
            ndvi_cog_path = os.path.join(cogs_dir, f"{display_name}_NDVI.tif")
            if not os.path.exists(ndvi_cog_path):
                log.info(f"Calculating NDVI block-by-block for {display_name}...")
                calculate_raster_index(b08_path, b04_path, ndvi_cog_path, formula_type="ndvi")
                
        # NDWI
        if os.path.exists(b03_path) and os.path.exists(b08_path):
            ndwi_cog_path = os.path.join(cogs_dir, f"{display_name}_NDWI.tif")
            if not os.path.exists(ndwi_cog_path):
                log.info(f"Calculating NDWI block-by-block for {display_name}...")
                calculate_raster_index(b03_path, b08_path, ndwi_cog_path, formula_type="ndwi")
    except Exception as e:
        log.error(f"Error calculating indices: {e}")

def scan_and_process():
    """Infinite loop that scans data directory and processes new TIFFs and SAFE dirs."""
    global processing_status
    data_path = Path(DATA_DIR)
    
    band_suffixes = {
        "band01": ["_B01_60m.jp2", "_B01.jp2"],
        "band02": ["_B02_10m.jp2", "_B02.jp2"],
        "band03": ["_B03_10m.jp2", "_B03.jp2"],
        "band04": ["_B04_10m.jp2", "_B04.jp2"],
        "band05": ["_B05_20m.jp2", "_B05.jp2"],
        "band06": ["_B06_20m.jp2", "_B06.jp2"],
        "band07": ["_B07_20m.jp2", "_B07.jp2"],
        "band08": ["_B08_10m.jp2", "_B08.jp2"],
        "band8A": ["_B8A_20m.jp2", "_B8A.jp2"],
        "band09": ["_B09_60m.jp2", "_B09.jp2"],
        "band11": ["_B11_20m.jp2", "_B11.jp2"],
        "band12": ["_B12_20m.jp2", "_B12.jp2"],
        "tci": ["_TCI_"]
    }
    
    while True:
        try:
            items_to_process = []
            
            # 1. Find .SAFE directories (Sentinel-2)
            safe_dirs = [p for p in data_path.rglob("*.SAFE") if p.is_dir()]
            for sdir in safe_dirs:
                items_to_process.append({"type": "safe", "path": sdir, "name": sdir.name})
                
            # 2. Find individual .tif files (excluding cogs dir)
            tif_files = [p for p in data_path.rglob("*.tif") if p.is_file()] + [p for p in data_path.rglob("*.tiff") if p.is_file()]
            for tfile in tif_files:
                if str(COGS_DIR) in str(tfile): continue
                items_to_process.append({"type": "tif", "path": tfile, "name": tfile.name})
            
            for item in items_to_process:
                original_name = item["name"]
                if is_image_processed(original_name):
                    continue
                    
                log.info(f"Found new dataset: {original_name}")
                processing_status.update({"progress": 10, "message": f"Processing {original_name}..."})
                
                existing = get_image_by_name(original_name)
                if existing:
                    image_id = existing["image_id"]
                    display_name = existing["display_name"]
                else:
                    image_id, display_name = reserve_image(original_name)
                if not image_id: continue
                
                local_cog_paths = {} # To store mapping of band -> local path
                main_local_cog = None
                main_bbox = None
                main_bands = 0
                main_res = None
                
                profile = cog_profiles.get("deflate")
                profile.update(blockxsize=512, blockysize=512)
                config = {"GDAL_TIFF_INTERNAL_MASK": True, "GDAL_TIFF_OVR_BLOCKSIZE": 512}
                
                if item["type"] == "safe":
                    sdir = item["path"]
                    # Find bands
                    found_bands = {}
                    all_jp2 = list(sdir.rglob("*.jp2"))
                    for jp2 in all_jp2:
                        name_str = jp2.name
                        if "MSK" in name_str or "QUALIT" in name_str or "PVI" in name_str:
                            continue
                        for b_key, suffixes in band_suffixes.items():
                            if any(s in name_str for s in suffixes):
                                found_bands[b_key] = jp2
                                break
                    
                    total_bands = len(found_bands)
                    if total_bands == 0:
                        log.warning(f"No JP2 bands found in {original_name}")
                        continue
                        
                    log.info(f"Processing {total_bands} bands for {display_name}")
                    idx = 1
                    for b_key, jp2_path in found_bands.items():
                        in_path = str(jp2_path)
                        out_cog_path = os.path.join(COGS_DIR, f"{display_name}_{b_key}.tif")
                        object_name = f"{display_name}_{b_key}.tif"
                        
                        if os.path.exists(out_cog_path):
                            log.info(f"COG already exists at {out_cog_path}, skipping conversion.")
                            local_path = f"/app/cogs/{object_name}"
                            local_cog_paths[b_key] = local_path
                            try:
                                s3_url = upload_cog_to_minio(out_cog_path, display_name, b_key)
                                log.info(f"Uploaded to MinIO: {s3_url}")
                            except Exception as e:
                                log.error(f"Failed to upload to MinIO: {e}")
                        else:
                            progress_pct = int(10 + ((idx - 1) / total_bands) * 80)
                            processing_status.update({"progress": progress_pct, "message": f"Converting {b_key} to COG ({idx}/{total_bands})..."})
                            log.info(f"Converting {b_key} to COG...")
                            try:
                                cog_translate(in_path, out_cog_path, profile, config=config, in_memory=False, quiet=True, overview_level=6, overview_resampling="bilinear")
                                local_path = f"/app/cogs/{object_name}"
                                log.info(f"Saved local COG to {out_cog_path}")
                                
                                # Upload to MinIO
                                try:
                                    s3_url = upload_cog_to_minio(out_cog_path, display_name, b_key)
                                    log.info(f"Uploaded to MinIO: {s3_url}")
                                except Exception as e:
                                    log.error(f"Failed to upload to MinIO: {e}")
                                    
                                if local_path:
                                    local_cog_paths[b_key] = local_path
                            except Exception as e:
                                log.error(f"Error converting {in_path} to COG: {e}")
                        
                        # Use band04 as main metadata source
                        if b_key == "band04" or (main_local_cog is None):
                            main_local_cog = local_path
                            try:
                                with rasterio.open(in_path) as cog:
                                    main_bbox = list(transform_bounds(cog.crs, "EPSG:4326", *cog.bounds, densify_pts=21))
                                    main_bands = cog.count
                                    main_res = cog.res[0] if cog.res else None
                            except Exception as ex:
                                log.error(f"Error reading band {b_key}: {ex}")
                        idx += 1
                        
                elif item["type"] == "tif":
                    in_path = str(item["path"])
                    out_cog_path = os.path.join(COGS_DIR, f"{display_name}.tif")
                    object_name = f"{display_name}.tif"
                    
                    if os.path.exists(out_cog_path):
                        log.info(f"COG already exists at {out_cog_path}, skipping conversion.")
                        local_path = f"/app/cogs/{object_name}"
                        main_local_cog = local_path
                        try:
                            s3_url = upload_cog_to_minio(out_cog_path, display_name, "data")
                            log.info(f"Uploaded to MinIO: {s3_url}")
                        except Exception as e:
                            log.error(f"Failed to upload to MinIO: {e}")
                        try:
                            with rasterio.open(out_cog_path) as cog:
                                main_bbox = list(transform_bounds(cog.crs, "EPSG:4326", *cog.bounds, densify_pts=21))
                                main_bands = cog.count
                                main_res = cog.res[0] if cog.res else None
                        except Exception as ex:
                            log.error(f"Error reading existing TIF COG: {ex}")
                    else:
                        processing_status.update({"progress": 30, "message": f"Converting {original_name} to COG..."})
                        try:
                            with rasterio.open(in_path) as src: input_dtype = src.dtypes[0]
                            cog_translate(in_path, out_cog_path, profile, dtype=input_dtype, overview_level=6, overview_resampling="bilinear", config=config, in_memory=False, quiet=True)
                            
                            processing_status.update({"progress": 70, "message": f"Saved {display_name} locally..."})
                            local_path = f"/app/cogs/{object_name}"
                            main_local_cog = local_path
                            
                            # Upload to MinIO
                            try:
                                s3_url = upload_cog_to_minio(out_cog_path, display_name, "data")
                                log.info(f"Uploaded to MinIO: {s3_url}")
                            except Exception as e:
                                log.error(f"Failed to upload to MinIO: {e}")
                                
                            with rasterio.open(out_cog_path) as cog:
                                main_bbox = list(transform_bounds(cog.crs, "EPSG:4326", *cog.bounds, densify_pts=21))
                                main_bands = cog.count
                                main_res = cog.res[0] if cog.res else None
                                
                        except Exception as ex:
                            log.error(f"Error converting TIF: {ex}")
                
                # Zarr Calculations
                processing_status.update({"progress": 95, "message": f"Pre-calculating Zarr indices for {display_name}..."})
                calculate_indices(display_name, COGS_DIR)
                        
                # 3. Update Database
                if main_local_cog:
                    update_image(
                        image_id=image_id,
                        cog_path=main_local_cog,
                        bbox=json.dumps(main_bbox) if main_bbox else None,
                        bands=main_bands,
                        resolution=main_res,
                        bands_json=json.dumps(local_cog_paths) if item["type"] == "safe" else None
                    )
                    log.info(f"Successfully processed {original_name} -> {display_name}")
                
                processing_status.update({"progress": 100, "message": "Scanning for new images..."})
                
        except Exception as e:
            log.error(f"Error in scanning loop: {e}")
            
        time.sleep(5) # Poll every 5 seconds

def start_processing_thread():
    """Launch COG conversion loop in a background thread."""
    thread = threading.Thread(target=scan_and_process, daemon=True)
    thread.start()
    return thread

if __name__ == "__main__":
    scan_and_process()
