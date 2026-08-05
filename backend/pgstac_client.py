import json
import psycopg2

def get_db_conn():
    return psycopg2.connect(
        host="localhost",
        port=5432,
        user="eo_user",
        password="eo_password",
        database="eo_platform"
    )

def _row_to_stac_item(row):
    """Convert a DB row (id, collection, geom_json, content) to a full STAC Item dict."""
    item_id, collection, geom_str, content = row
    item = dict(content)
    item["id"] = item_id
    item["type"] = "Feature"
    item["stac_version"] = "1.0.0"
    item["collection"] = collection
    if geom_str:
        item["geometry"] = json.loads(geom_str)
    # Ensure links list exists (required by some STAC consumers)
    if "links" not in item:
        item["links"] = []
    return item

def init_pgstac():
    collections = [
        {
            "id": "Sentinel2",
            "type": "Collection",
            "stac_version": "1.0.0",
            "description": "Sentinel-2 Imagery Catalog",
            "license": "proprietary",
            "extent": {
                "spatial": {"bbox": [[-180, -90, 180, 90]]},
                "temporal": {"interval": [["2020-01-01T00:00:00Z", None]]}
            },
            "links": []
        },
        {
            "id": "Landsat",
            "type": "Collection",
            "stac_version": "1.0.0",
            "description": "Landsat Imagery Catalog",
            "license": "proprietary",
            "extent": {
                "spatial": {"bbox": [[-180, -90, 180, 90]]},
                "temporal": {"interval": [["1970-01-01T00:00:00Z", None]]}
            },
            "links": []
        },
        {
            "id": "Generic",
            "type": "Collection",
            "stac_version": "1.0.0",
            "description": "Generic Imagery Catalog",
            "license": "proprietary",
            "extent": {
                "spatial": {"bbox": [[-180, -90, 180, 90]]},
                "temporal": {"interval": [["1970-01-01T00:00:00Z", None]]}
            },
            "links": []
        }
    ]
    try:
        conn = get_db_conn()
        conn.autocommit = True
        with conn.cursor() as cur:
            for collection in collections:
                cur.execute("SELECT id FROM pgstac.collections WHERE id = %s;", (collection["id"],))
                if cur.fetchone() is None:
                    cur.execute("SELECT pgstac.create_collection(%s::jsonb);", (json.dumps(collection),))
                    print(f"pgSTAC: Created '{collection['id']}' collection.")
                else:
                    print(f"pgSTAC: '{collection['id']}' collection already exists.")
        conn.close()
    except Exception as e:
        print("pgSTAC Initialization Warning:", e)

def register_stac_item(item_dict: dict):
    conn = get_db_conn()
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pgstac.items WHERE id = %s;", (item_dict["id"],))
            if cur.fetchone() is not None:
                cur.execute("DELETE FROM pgstac.items WHERE id = %s;", (item_dict["id"],))
            cur.execute("SELECT pgstac.create_item(%s::jsonb);", (json.dumps(item_dict),))
            print(f"pgSTAC: Registered STAC Item '{item_dict['id']}' successfully.")
    finally:
        conn.close()

def search_stac_items(filters: dict):
    """Query pgSTAC items, returning full STAC Item dicts (with id, geometry merged)."""
    conn = get_db_conn()
    query = "SELECT id, collection, ST_AsGeoJSON(geometry), content FROM pgstac.items WHERE 1=1"
    params = []

    # Text filters
    fields = ["mission", "sensor", "processing_level", "product_type", "tile_id", "resolution", "place"]
    for field in fields:
        val = filters.get(field)
        if val:
            query += f" AND content->'properties'->>'{field}' = %s"
            params.append(val)

    # Date filter
    if filters.get("start_date"):
        query += " AND SUBSTRING(content->'properties'->>'datetime' FROM 1 FOR 10) >= %s"
        params.append(filters["start_date"])
    if filters.get("end_date"):
        query += " AND SUBSTRING(content->'properties'->>'datetime' FROM 1 FOR 10) <= %s"
        params.append(filters["end_date"])

    # Cloud cover range (format: "0-10", "10-20", etc.)
    if filters.get("cloud_cover"):
        cc_range = filters["cloud_cover"]
        try:
            low, high = map(float, cc_range.split("-"))
            query += " AND (content->'properties'->>'cloud_cover')::float >= %s AND (content->'properties'->>'cloud_cover')::float <= %s"
            params.append(low)
            params.append(high)
        except Exception as e:
            print(f"pgSTAC Search: Failed parsing cloud cover range '{cc_range}': {e}")

    try:
        with conn.cursor() as cur:
            cur.execute(query, tuple(params))
            rows = cur.fetchall()
            items = [_row_to_stac_item(row) for row in rows]
    finally:
        conn.close()

    return items

def get_stac_item_by_id(item_id: str):
    """Return a single full STAC Item dict by ID, or None."""
    conn = get_db_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, collection, ST_AsGeoJSON(geometry), content FROM pgstac.items WHERE id = %s;",
                (item_id,)
            )
            row = cur.fetchone()
            return _row_to_stac_item(row) if row else None
    finally:
        conn.close()

def get_distinct_filter_values(filters: dict = None):
    conn = get_db_conn()
    fields = {
        "mission":           "content->'properties'->>'mission'",
        "sensor":            "content->'properties'->>'sensor'",
        "processing_level":  "content->'properties'->>'processing_level'",
        "product_type":      "content->'properties'->>'product_type'",
        "tile_id":           "content->'properties'->>'tile_id'",
        "resolution":        "content->'properties'->>'resolution'",
        "place":             "content->'properties'->>'place'",
        "date":              "SUBSTRING(content->'properties'->>'datetime' FROM 1 FOR 10)"
    }
    
    where_clauses = []
    params = []
    if filters:
        for k, col in fields.items():
            if filters.get(k):
                where_clauses.append(f"{col} = %s")
                params.append(filters[k])
        
        if filters.get("cloud_cover"):
            try:
                max_cc = float(filters["cloud_cover"])
                where_clauses.append("(content->'properties'->>'eo:cloud_cover')::numeric <= %s")
                params.append(max_cc)
            except ValueError:
                pass

    base_where = " AND ".join(where_clauses) if where_clauses else "1=1"

    results = {}
    try:
        with conn.cursor() as cur:
            for key, col in fields.items():
                cur.execute(
                    f"SELECT DISTINCT {col} FROM pgstac.items WHERE {col} IS NOT NULL AND {base_where} ORDER BY {col} ASC;",
                    tuple(params)
                )
                results[key] = [row[0] for row in cur.fetchall()]
    finally:
        conn.close()
    return results
