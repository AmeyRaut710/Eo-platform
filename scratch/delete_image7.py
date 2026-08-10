import os
import shutil
import psycopg2
import boto3
from botocore.client import Config

print("=== DELETING IMAGE7 FROM ALL STORAGE & METADATA LOCATIONS ===")

# 1. Delete from PgSTAC database
print("\n[1/3] Deleting from PgSTAC database...")
try:
    conn = psycopg2.connect(
        host="localhost",
        port=5432,
        user="eo_user",
        password="eo_password",
        database="eo_platform"
    )
    conn.autocommit = True
    with conn.cursor() as cur:
        # Delete item 'image7' or any matching 'image7' ID
        cur.execute("DELETE FROM pgstac.items WHERE id = 'image7' OR id LIKE '%image7%';")
        deleted_count = cur.rowcount
        print(f"  -> Deleted {deleted_count} items from pgstac.items table.")
    conn.close()
except Exception as e:
    print(f"  -> PgSTAC Deletion Error: {e}")

# 2. Delete from MinIO bucket
print("\n[2/3] Deleting from MinIO bucket 'eo-platform'...")
try:
    s3 = boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        aws_access_key_id="admin",
        aws_secret_access_key="admin123",
        config=Config(signature_version="s3v4"),
        region_name="us-east-1"
    )
    bucket = "eo-platform"
    paginator = s3.get_paginator('list_objects_v2')
    deleted_objs = 0
    for page in paginator.paginate(Bucket=bucket):
        if 'Contents' in page:
            for obj in page['Contents']:
                key = obj['Key']
                if 'image7' in key.lower():
                    s3.delete_object(Bucket=bucket, Key=key)
                    print(f"  -> Deleted MinIO object: {key}")
                    deleted_objs += 1
    print(f"  -> Total deleted MinIO objects: {deleted_objs}")
except Exception as e:
    print(f"  -> MinIO Deletion Error: {e}")

# 3. Delete from Local Folder vista_data/image7
print("\n[3/3] Deleting from local folder backend/vista_data/image7...")
folder_path = r"d:\ISRO\backend\vista_data\image7"
if os.path.exists(folder_path):
    try:
        shutil.rmtree(folder_path)
        print(f"  -> Successfully removed folder: {folder_path}")
    except Exception as e:
        print(f"  -> Error deleting folder {folder_path}: {e}")
else:
    print(f"  -> Folder {folder_path} does not exist.")

print("\n=== DELETION COMPLETE ===")
