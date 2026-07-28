@echo off
setlocal enabledelayedexpansion

set AWS_ACCESS_KEY_ID=admin
set AWS_SECRET_ACCESS_KEY=admin123
set AWS_S3_ENDPOINT=localhost:9000
set AWS_ENDPOINT_URL=http://localhost:9000
set AWS_VIRTUAL_HOSTING=FALSE
set AWS_HTTPS=NO

REM Root of the repository (this script lives in the project root)
set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%backend"

REM Start background database and storage containers
echo Starting Docker containers (MinIO, PostgreSQL)...
docker start minio postgres_db >nul 2>&1
if errorlevel 1 (
    echo [Warning] Failed to start Docker containers. Make sure Docker is running if you need MinIO/pgSTAC.
)

REM Kill any stale servers on ports 8000 / 8001 before starting fresh
echo Stopping any existing servers on ports 8000 and 8001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000 " ^| findstr "LISTENING" 2^>nul') do (
    tasklist /FI "PID eq %%a" | find /I "python.exe" >nul && taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8001 " ^| findstr "LISTENING" 2^>nul') do (
    tasklist /FI "PID eq %%a" | find /I "python.exe" >nul && taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

REM Create or activate venv
if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo Failed to create virtual environment. Ensure Python is installed and on PATH.
        pause
        exit /b 1
    )
    echo Activating virtual environment and installing dependencies...
    call ".venv\Scripts\activate"
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
) else (
    echo Activating existing virtual environment...
    call ".venv\Scripts\activate"
)

REM Start TiTiler in a new window (pass S3/MinIO env vars so TiTiler can resolve s3:// asset hrefs)
start "TiTiler" cmd /k "set AWS_ACCESS_KEY_ID=admin&& set AWS_SECRET_ACCESS_KEY=admin123&& set AWS_S3_ENDPOINT=localhost:9000&& set AWS_ENDPOINT_URL=http://localhost:9000&& set AWS_VIRTUAL_HOSTING=FALSE&& set AWS_HTTPS=NO&& set GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR&& set CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=NO&& cd /d "%ROOT_DIR%backend"&& .venv\Scripts\activate&& uvicorn titiler.application.main:app --port 8001 --host 0.0.0.0"

REM Start FastAPI backend in a new window
start "EO Platform Backend" cmd /k "set AWS_ACCESS_KEY_ID=admin&& set AWS_SECRET_ACCESS_KEY=admin123&& set AWS_S3_ENDPOINT=localhost:9000&& set AWS_ENDPOINT_URL=http://localhost:9000&& set AWS_VIRTUAL_HOSTING=FALSE&& set AWS_HTTPS=NO&& cd /d "%ROOT_DIR%backend"&& .venv\Scripts\activate&& uvicorn main:app --port 8000 --host 0.0.0.0"

echo.
echo TiTiler is starting on http://localhost:8001
echo FastAPI backend is starting on http://localhost:8000
echo Open the app in your browser: http://localhost:8000/
echo.
pause
