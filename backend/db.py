import os
import json
import datetime

DB_FILE = os.path.join(os.path.dirname(__file__), 'db.json')

def load_db():
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, 'r') as f:
                db_data = json.load(f)
                return {int(k): v for k, v in db_data.items()}
        except:
            return {}
    return {}

def save_db(db_data):
    with open(DB_FILE, 'w') as f:
        json.dump(db_data, f, indent=4)

def init_db():
    if not os.path.exists(DB_FILE):
        save_db({})

def get_all_images():
    db_data = load_db()
    return list(db_data.values())

def get_image_by_id(image_id):
    db_data = load_db()
    return db_data.get(int(image_id))

def is_image_processed(name):
    db_data = load_db()
    for img in db_data.values():
        if img["original_name"] == name:
            return img.get("cog_path") is not None
    return False

def get_image_by_name(name):
    db_data = load_db()
    for img in db_data.values():
        if img["original_name"] == name:
            return img
    return None

def reserve_image(name):
    db_data = load_db()
    image_id = max(db_data.keys()) + 1 if db_data else 1
    display_name = f"img{image_id}"
    
    db_data[image_id] = {
    "image_id": image_id,
    "display_name": display_name,
    "original_name": name,
    "cog_path": None,

    # Existing
    "created_at": datetime.datetime.now().isoformat(),

    # New Metadata (Optional)
    "mission": None,
    "sensor": None,
    "processing_level": None,
    "product_type": None,
    "place": None,
    "acquisition_date": None,
    "cloud_cover": None,
    "resolution": None,
    "tile_id": None,
    "bbox": None,
    "footprint": None,
    "crs": None,
    "bands": None,
    "bands_json": None,

    # Future MinIO / pgSTAC
        "minio_path": None,
        "stac_item_id": None
    }
    save_db(db_data)
    return image_id, display_name

def update_image(
    image_id,
    cog_path=None,
    bbox=None,
    bands=None,
    resolution=None,
    bands_json=None,
    mission=None,
    sensor=None,
    processing_level=None,
    product_type=None,
    place=None,
    acquisition_date=None,
    cloud_cover=None,
    tile_id=None,
    footprint=None,
    crs=None,
    minio_path=None,
    stac_item_id=None
):
    db_data = load_db()
    image_id = int(image_id)

    if image_id in db_data:
        img = db_data[image_id]

        if cog_path is not None:
            img["cog_path"] = cog_path

        if bbox is not None:
            img["bbox"] = bbox

        if bands is not None:
            img["bands"] = bands

        if resolution is not None:
            img["resolution"] = resolution

        if bands_json is not None:
            img["bands_json"] = bands_json

        # New Metadata
        if mission is not None:
            img["mission"] = mission

        if sensor is not None:
            img["sensor"] = sensor

        if processing_level is not None:
            img["processing_level"] = processing_level

        if product_type is not None:
            img["product_type"] = product_type

        if place is not None:
            img["place"] = place

        if acquisition_date is not None:
            img["acquisition_date"] = acquisition_date

        if cloud_cover is not None:
            img["cloud_cover"] = cloud_cover

        if tile_id is not None:
            img["tile_id"] = tile_id

        if footprint is not None:
            img["footprint"] = footprint

        if crs is not None:
            img["crs"] = crs

        if minio_path is not None:
            img["minio_path"] = minio_path

        if stac_item_id is not None:
            img["stac_item_id"] = stac_item_id

        save_db(db_data)