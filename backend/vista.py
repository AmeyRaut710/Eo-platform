import os
import glob
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from fastapi import APIRouter, Request
from cogeo_mosaic.mosaic import MosaicJSON

router = APIRouter()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VISTA_DATA_DIR = os.path.join(BASE_DIR, "vista_data")
COGS_DIR = os.path.join(BASE_DIR, "cogs")

def scan_vista_data(request: Request):
    results = []
    xml_files = glob.glob(os.path.join(VISTA_DATA_DIR, "**", "MTD_MSIL*.xml"), recursive=True)
    
    for xml_path in xml_files:
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            # Extract Cloud Cover
            cc_elem = next(root.iter('Cloud_Coverage_Assessment'), None)
            cc = float(cc_elem.text) if cc_elem is not None else 100.0
            
            # Extract Acquisition Date
            date_elem = next(root.iter('PRODUCT_START_TIME'), None)
            date_str = date_elem.text if date_elem is not None else "1970-01-01T00:00:00.000Z"
            
            folder = os.path.dirname(xml_path)
            image_name = os.path.basename(folder)
            
            # Get TCI (prefer COG/TIF over raw JP2 for 100x performance)
            tci_files = list(Path(folder).rglob("*_TCI_10m.tif"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI_10m.jp2"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI.tif"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI.jp2"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI_20m.tif"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI_20m.jp2"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI_60m.tif"))
            if not tci_files:
                tci_files = list(Path(folder).rglob("*_TCI_60m.jp2"))
            if not tci_files:
                continue
                
            tci_path = str(tci_files[0])
            
            rel_path = os.path.relpath(tci_path, BASE_DIR).replace("\\", "/")
            titiler_url = f"/app/{rel_path}"
            
            # Resolve to full HTTP URL for TiTiler
            base_url = os.environ.get("FASTAPI_INTERNAL_URL", str(request.base_url).rstrip("/"))
            titiler_url = f"{base_url}{titiler_url}"
            
            res = 10
            if "20m" in tci_path:
                res = 20
            elif "60m" in tci_path:
                res = 60
                
            results.append({
                "name": image_name,
                "cloud_cover": cc,
                "acquisition_date": date_str,
                "resolution": res,
                "tci_local": tci_path,
                "tci_url": titiler_url
            })
        except Exception as e:
            print(f"Warning: Skipped {xml_path} due to missing metadata or file: {e}")
            
    # Priority: Least Cloud Cover -> Latest Date -> Better Res
    # Lower cloud cover is better. Later date is better (so negative value for sorting).
    def date_score(d):
        return -float(d.replace("-", "").replace(":", "").replace("T", "").replace("Z", "").replace(".", ""))
        
    results.sort(key=lambda x: (x["cloud_cover"], date_score(x["acquisition_date"]), x["resolution"]))
    
    return results

@router.get("/images", summary="List images in Vista Mode")
def get_images(request: Request):
    """Returns all images found in vista_data sorted by priority."""
    return scan_vista_data(request)

@router.get("/mosaic", summary="Generate MosaicJSON for Vista Mode")
def get_mosaic(request: Request):
    """Dynamically generates a MosaicJSON based on the prioritised images."""
    images = scan_vista_data(request)
    if not images:
        return {"tiles": {}}
        
    local_urls = []
    url_mapping = {}
    for img in images:
        local_urls.append(img["tci_local"])
        url_mapping[img["tci_local"]] = img["tci_url"]
        
    # Generate MosaicJSON using local file paths to avoid deadlocks
    # cogeo_mosaic places first URLs on top (highest priority)
    mosaic = MosaicJSON.from_urls(local_urls)
    mosaic_dict = mosaic.dict(exclude_none=True)
    
    # Replace local paths with HTTP URLs
    for quadkey, asset_list in mosaic_dict["tiles"].items():
        mosaic_dict["tiles"][quadkey] = [url_mapping[asset] for asset in asset_list]
        
    return mosaic_dict

def convert_vista_jp2_to_cogs():
    """Background task to translate all raw Sentinel-2 JP2 files in vista_data to optimized COGs."""
    import time
    from rio_cogeo.cogeo import cog_translate
    from rio_cogeo.profiles import cog_profiles
    
    print("Vista COG background thread started...")
    xml_files = glob.glob(os.path.join(VISTA_DATA_DIR, "**", "MTD_MSIL*.xml"), recursive=True)
    
    for xml_path in xml_files:
        try:
            folder = os.path.dirname(xml_path)
            # Find only TCI JP2 files to optimize space and time
            jp2_files = []
            for pattern in ["*_TCI_10m.jp2", "*_TCI.jp2", "*_TCI_20m.jp2", "*_TCI_60m.jp2"]:
                jp2_files.extend(list(Path(folder).rglob(pattern)))
            for jp2_path in jp2_files:
                jp2_str = str(jp2_path)
                cog_str = jp2_str.replace(".jp2", ".tif")
                if os.path.exists(cog_str):
                    continue
                
                print(f"Vista Optimization: Converting {os.path.basename(jp2_str)} to COG...")
                t0 = time.time()
                try:
                    profile = cog_profiles.get("deflate")
                    profile.update(blockxsize=512, blockysize=512)
                    config = {"GDAL_TIFF_INTERNAL_MASK": True, "GDAL_TIFF_OVR_BLOCKSIZE": 512}
                    cog_translate(jp2_str, cog_str, profile, config=config, in_memory=False, quiet=True)
                    print(f"Vista Optimization: Finished converting {os.path.basename(jp2_str)} to COG in {time.time() - t0:.2f} seconds.")
                except Exception as ex:
                    print(f"Vista Optimization Error: Failed to convert {jp2_str} to COG: {ex}")
        except Exception as e:
            print(f"Vista Optimization Error: Failed parsing {xml_path}: {e}")
            
    print("Vista COG background thread finished conversion scan.")

def start_vista_conversion_thread():
    """Starts the background JP2 to COG conversion thread."""
    import threading
    thread = threading.Thread(target=convert_vista_jp2_to_cogs, daemon=True)
    thread.start()
    return thread

