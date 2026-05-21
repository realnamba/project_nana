@echo off
echo ============================================
echo   Project Nana — Setup Script
echo ============================================
echo.

cd /d "%~dp0"

REM Step 1: Create virtual environment if it doesn't exist
if not exist "backend\venv" (
    echo [1/3] Creating Python virtual environment...
    "C:\Users\LENOV\AppData\Local\Programs\Python\Python312\python.exe" -m venv backend\venv
    echo      Done.
) else (
    echo [1/3] Virtual environment already exists.
)

REM Step 2: Install Python packages
echo [2/3] Installing Python packages...
call backend\venv\Scripts\activate.bat
pip install fastapi uvicorn[standard] httpx sse-starlette pydantic aiosqlite Pillow python-dotenv mss
echo      Done.

REM Step 3: Pull Ollama models
echo [3/3] Pulling Ollama models...
ollama pull qwen2.5-coder:3b
echo      Done.
echo.
echo ============================================
echo   Setup complete! Run start.bat to launch.
echo ============================================
pause
