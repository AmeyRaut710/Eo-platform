"""
processing.py
=============
Converts an input GeoTIFF → Cloud Optimized GeoTIFF (COG)
with internal tiling and pyramid overviews.

Run standalone:
    python processing.py
"""

import os
import threading
import time
import logging

import rasterio
from rasterio.enums import Resampling
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.join(BASE_DIR, "data")
INPUT_FILE  = os.path.join(DATA_DIR, "input.tif")
OUTPUT_FILE = os.path.join(DATA_DIR, "output_cog.tif")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("processing")

# ── Status shared across threads ──────────────────────────────────────────────
processing_status = {
    "running":   False,
    "done":      False,
    "error":     None,
    "progress":  0,       # 0-100
    "message":   "idle",
}


# ── Core conversion function ──────────────────────────────────────────────────
def convert_to_cog():
    """Read INPUT_FILE, convert to COG with LZW compression + pyramids."""
    global processing_status

    processing_status.update({"running": True, "done": False,
                               "error": None, "progress": 0,
                               "message": "Starting conversion…"})

    try:
        # ── 1. Validate input ─────────────────────────────────────────────────
        if not os.path.exists(INPUT_FILE):
            raise FileNotFoundError(
                f"Input file not found: {INPUT_FILE}\n"
                "Place your GeoTIFF at backend/data/input.tif"
            )

        log.info("Opening input file: %s", INPUT_FILE)
        processing_status.update({"progress": 10,
                                   "message": "Reading input TIFF…"})

        with rasterio.open(INPUT_FILE) as src:
            log.info("  CRS   : %s", src.crs)
            log.info("  Shape : %s × %s × %s bands",
                     src.width, src.height, src.count)
            log.info("  Dtype : %s", src.dtypes[0])
            input_dtype = src.dtypes[0]

        # ── 2. Build COG profile ─────────────────────────────────────────────
        processing_status.update({"progress": 20,
                                   "message": "Building COG profile…"})

        profile = cog_profiles.get("deflate")   # LZW-like but better
        profile.update(
            blockxsize=256,
            blockysize=256,
        )

        # ── 3. Convert TIFF → COG ─────────────────────────────────────────────
        log.info("Converting to COG → %s", OUTPUT_FILE)
        processing_status.update({"progress": 40,
                                   "message": "Converting TIFF → COG…"})

        config = {
            "GDAL_TIFF_INTERNAL_MASK": True,
            "GDAL_TIFF_OVR_BLOCKSIZE": 256,
        }

        cog_translate(
            INPUT_FILE,
            OUTPUT_FILE,
            profile,
            dtype=input_dtype,
            overview_level=4,                   # 4 pyramid levels
            overview_resampling="nearest",
            config=config,
            in_memory=False,
            quiet=False,
        )

        processing_status.update({"progress": 80,
                                   "message": "Verifying COG…"})

        # ── 4. Verify output ──────────────────────────────────────────────────
        if not os.path.exists(OUTPUT_FILE):
            raise RuntimeError("COG file was not created.")

        with rasterio.open(OUTPUT_FILE) as cog:
            log.info("COG created successfully")
            log.info("  File  : %s", OUTPUT_FILE)
            log.info("  Size  : %.1f MB",
                     os.path.getsize(OUTPUT_FILE) / 1_048_576)
            log.info("  CRS   : %s", cog.crs)
            log.info("  Overviews: %s", cog.overviews(1))

        processing_status.update({
            "running":  False,
            "done":     True,
            "progress": 100,
            "message":  " COG created successfully!",
        })
        log.info("Processing complete.")

    except Exception as exc:
        log.error("Processing failed: %s", exc)
        processing_status.update({
            "running": False,
            "done":    False,
            "error":   str(exc),
            "message": f"Error: {exc}",
        })


# ── Threaded launcher ─────────────────────────────────────────────────────────
def start_processing_thread():
    """Launch COG conversion in a background thread."""
    thread = threading.Thread(target=convert_to_cog, daemon=True)
    thread.start()
    return thread


# ── Standalone entry-point ────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("=== EO Platform — TIFF → COG Converter ===")
    t = start_processing_thread()
    t.join()          # wait for completion when running directly
    log.info("Status: %s", processing_status["message"])
