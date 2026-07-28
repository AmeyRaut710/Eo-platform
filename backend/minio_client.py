import os
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from pathlib import Path

# Configure S3 environment variables programmatically so that current process
# and any spawned subprocesses (like TiTiler or GDAL) inherit them.
S3_KEYS = {
    "AWS_ACCESS_KEY_ID": "admin",
    "AWS_SECRET_ACCESS_KEY": "admin123",
    "AWS_S3_ENDPOINT": "localhost:9000",
    "AWS_ENDPOINT_URL": "http://localhost:9000",
    "AWS_VIRTUAL_HOSTING": "FALSE",
    "AWS_HTTPS": "NO"
}

for k, v in S3_KEYS.items():
    os.environ[k] = v

BUCKET_NAME = "eo-platform"

def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        aws_access_key_id="admin",
        aws_secret_access_key="admin123",
        config=Config(signature_version="s3v4"),
        region_name="us-east-1"
    )

def init_minio():
    s3 = get_s3_client()
    try:
        s3.create_bucket(Bucket=BUCKET_NAME)
        print(f"MinIO: Bucket '{BUCKET_NAME}' created successfully.")
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    except s3.exceptions.BucketAlreadyExists:
        pass
    except Exception as e:
        print(f"MinIO Connection Warning: {e}")

def upload_cog_to_minio(local_path: str, dataset_name: str, band_name: str) -> str:
    """
    Uploads a COG file to MinIO under the prefix Sentinel2/{dataset_name}/{band_name}.tif
    Returns the s3:// path. Skips upload if the object already exists.
    """
    s3 = get_s3_client()
    object_name = f"Sentinel2/{dataset_name}/{band_name}.tif"
    
    # Check if already uploaded to avoid redundant work
    try:
        s3.head_object(Bucket=BUCKET_NAME, Key=object_name)
        return f"s3://{BUCKET_NAME}/{object_name}"  # Already exists
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchKey"):
            print(f"MinIO: Unexpected error checking object: {e}")
    except Exception as e:
        print(f"MinIO: Error checking object existence: {e}")
    
    print(f"MinIO: Uploading {os.path.basename(local_path)} to s3://{BUCKET_NAME}/{object_name}...")
    s3.upload_file(local_path, BUCKET_NAME, object_name)
    return f"s3://{BUCKET_NAME}/{object_name}"

