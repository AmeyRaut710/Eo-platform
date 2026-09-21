# EO Platform Technical Documentation

## Overview
The EO Platform is a dynamic Earth Observation (EO) satellite imagery visualization and processing system. It enables users to browse, process, and analyze massive satellite datasets (such as Sentinel-2, Landsat, and Resourcesat-2) directly in the browser through on-the-fly dynamic tiling, rather than relying on pre-rendered map tiles.

## System Architecture
The system follows a modern decoupled architecture:
1. **Frontend (Client)**: A Vanilla JavaScript application utilizing HTML5 canvas and Leaflet for geospatial rendering. It handles user interactions, region-of-interest drawing, and dynamic band manipulation (RGB combinations, index calculations like NDVI).
2. **Backend (API)**: A FastAPI-based Python server that orchestrates data ingestion, metadata extraction, background tasks, and serves as the bridge between the frontend and the data storage layer.
3. **Dynamic Tiler (TiTiler)**: A specialized FastAPI application powered by `rasterio` and `rio-tiler`. It translates web map tile requests (Z/X/Y) into on-the-fly renders of specific regions of Cloud Optimized GeoTIFFs (COGs).
4. **Metadata Catalog (pgSTAC)**: A PostgreSQL database optimized for Spatiotemporal Asset Catalogs (STAC). It stores bounding boxes, acquisition dates, and cloud cover metrics, allowing the frontend to search for imagery intersecting a specific point or bounding box.
5. **Object Storage (MinIO)**: An S3-compatible local object storage system holding the actual heavy COG raster files.

## Data Ingestion Pipeline
When raw satellite data (like `.SAFE` folders or `.MTL` packages) is placed in the `vista_data` directory, the backend's continuous background thread (`convert_vista_jp2_to_cogs`) initiates:
1. **Metadata Extraction**: Parses XML or text metadata files to identify the sensor, acquisition time, footprint polygon, and bands.
2. **COG Translation**: Uses `rio-cogeo` to convert raw JPEG2000 (`.jp2`) or standard TIFFs into Cloud Optimized GeoTIFFs. COGs have internal overviews and tile structures, making it possible for TiTiler to fetch only the bytes needed for a specific zoom level using HTTP GET Range requests.
3. **Storage & Registration**: Uploads the COG to MinIO via `boto3` and registers a STAC Item in the pgSTAC database using `psycopg2`.

## Core Technologies and Libraries
### Backend
- **FastAPI**: Provides high-performance, asynchronous REST API endpoints.
- **Uvicorn**: ASGI web server implementation used to run both the FastAPI app and TiTiler.
- **TiTiler (`titiler.application`)**: The core engine for dynamic tile generation. It dynamically processes math expressions (e.g., `(B08-B04)/(B08+B04)`) across raster bands requested by the frontend.
- **Rasterio & GDAL**: The fundamental geospatial abstraction libraries in Python for reading and transforming raster bounds and CRSs.
- **rio-cogeo**: Library to enforce the COG specification, ensuring fast cloud-native access.
- **Boto3**: AWS SDK for Python, configured to communicate with the local MinIO instance.
- **psycopg2**: PostgreSQL adapter used to execute raw SQL queries against the pgSTAC schema.
- **Xarray & Dask**: Advanced multidimensional array libraries utilized in `processing.py` to handle large-scale custom script executions across spatial chunks in parallel.

### Frontend
- **Vanilla JavaScript & HTML5/CSS3**: Lightweight implementation ensuring rapid execution without heavy framework overhead.
- **Leaflet (implied geospatial logic)**: Used for projecting the Web Mercator tiles (`Z/X/Y`) and rendering polygon geometries over a basemap.
- **Fetch API**: For asynchronous communication with the backend (searching STAC items, retrieving dynamic tile URLs).

## Custom Script Execution
The platform allows users to submit custom Python processing scripts (via `custom_script.py`). The backend dynamically loads these scripts using `ast` (Abstract Syntax Trees) to validate safety, and executes them against multidimensional `xarray` datasets to generate new output indices or classifications on the fly.
