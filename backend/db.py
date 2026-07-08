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
    image_id = 1
    if db_data:
        image_id = max(db_data.keys()) + 1
        
    display_name = f"img{image_id}"
        
    db_data[image_id] = {
        "image_id": image_id,
        "display_name": display_name,
        "original_name": name,
        "cog_path": None,
        "created_at": datetime.datetime.now().isoformat()
    }
    save_db(db_data)
    return image_id, display_name

def update_image(image_id, cog_path=None, bbox=None, bands=None, resolution=None, bands_json=None):
    db_data = load_db()
    image_id = int(image_id)
    if image_id in db_data:
        img = db_data[image_id]
        if cog_path is not None: img["cog_path"] = cog_path
        if bbox is not None: img["bbox"] = bbox
        if bands is not None: img["bands"] = bands
        if resolution is not None: img["resolution"] = resolution
        if bands_json is not None: img["bands_json"] = bands_json
        save_db(db_data)
