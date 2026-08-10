import os
import sys
import subprocess
import time

env = os.environ.copy()
env.update({
    "AWS_ACCESS_KEY_ID": "admin",
    "AWS_SECRET_ACCESS_KEY": "admin123",
    "AWS_S3_ENDPOINT": "localhost:9000",
    "AWS_ENDPOINT_URL": "http://localhost:9000",
    "AWS_VIRTUAL_HOSTING": "FALSE",
    "AWS_HTTPS": "NO",
    "AWS_DEFAULT_REGION": "us-east-1",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE": "NO"
})

python_exe = sys.executable

print("Starting TiTiler on port 8001...")
p_titiler = subprocess.Popen([python_exe, "-m", "uvicorn", "titiler.application.main:app", "--port", "8001", "--host", "0.0.0.0"], env=env)

print("Starting FastAPI Backend on port 8000...")
p_backend = subprocess.Popen([python_exe, "-m", "uvicorn", "main:app", "--port", "8000", "--host", "0.0.0.0"], env=env)

print("Both servers started successfully!")

try:
    p_titiler.wait()
    p_backend.wait()
except KeyboardInterrupt:
    p_titiler.terminate()
    p_backend.terminate()
