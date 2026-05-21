@echo off
cd /d "%~dp0"
call venv\Scripts\activate.bat
pip install fastapi uvicorn[standard] sse-starlette pydantic aiosqlite Pillow python-dotenv mss llama-cpp-python
echo.
echo === Installation complete ===
pause
