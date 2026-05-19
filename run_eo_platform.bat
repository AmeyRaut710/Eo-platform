@echo off
setlocal enabledelayedexpansion

REM Root of the repository (this script lives in the project root)
set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%backend"

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

REM Start TiTiler in a new window
start "TiTiler" cmd /k "cd /d "%ROOT_DIR%backend" && .venv\Scripts\activate && uvicorn titiler.application.main:app --port 8001 --reload"

REM Start FastAPI backend in a new window
start "EO Platform Backend" cmd /k "cd /d "%ROOT_DIR%backend" && .venv\Scripts\activate && uvicorn main:app --port 8000 --reload"

echo.
echo TiTiler is starting on http://localhost:8001
echo FastAPI backend is starting on http://localhost:8000
echo Open the app in your browser: http://localhost:8000/
echo.
pause
