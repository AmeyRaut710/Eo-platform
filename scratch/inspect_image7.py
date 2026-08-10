import os
import psycopg2
import json
from minio import Minio

# 1. Connect to PostgreSQL / PgSTAC
print("--- Checking PgSTAC Database ---")
try:
    conn = psycopg2.connect(
        host="localhost",
        port=5432,
        user="eo_user",
        password="eo_password",
        database="eo_platform"
    )
    cur = conn.cursor()
    cur.execute("SELECT id, collection FROM pgstac.items WHERE id LIKE '%144045%' OR id LIKE '%image7%' OR id LIKE '%LC8%';")
    rows = cur.fetchall()
    print("Found STAC Items in PgSTAC:")
    for r in rows:
        print("  - Item ID:", r[0], "| Collection:", r[1])
    
    # Also check all items in pgstac
    cur.execute("SELECT id, collection FROM pgstac.items;")
    all_rows = cur.fetchall()
    print("\nAll Items in PgSTAC:")
    for r in all_rows:
        print("  - Item ID:", r[0], "| Collection:", r[1])
    conn.close()
except Exception as e:
    print("PgSTAC error:", e)

# 2. Check MinIO
print("\n--- Checking MinIO ---")
try:
    client = Minio("localhost:9000", access_key="minioadmin", secret_key="minioadmin", secure=False)
    buckets = client.list_buckets()
    print("Buckets:", [b.name for b in buckets])
    for b in buckets:
        objects = list(client.list_objects(b.name, recursive=True))
        print(f"Bucket {b.name} objects count: {len(objects)}")
        for obj in objects:
            if "image7" in obj.object_name.lower() or "144045" in obj.object_name.lower() or "lc8" in obj.object_name.lower():
                print("  Found matching object:", obj.object_name)
except Exception as e:
    print("MinIO error:", e)
