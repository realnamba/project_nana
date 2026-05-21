@echo off
echo ============================================
echo   Project Nana — Starting...
echo ============================================
cd /d "%~dp0\backend"
call venv\Scripts\activate.bat
echo.
echo   Open http://127.0.0.1:8777 in your browser
echo   Press Ctrl+C to stop
echo.
python run.py
