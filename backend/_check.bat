@echo off
cd /d "%~dp0"
call venv\Scripts\activate.bat
pip list --format=columns 2>&1
echo ---EXIT_CODE:%ERRORLEVEL%---
