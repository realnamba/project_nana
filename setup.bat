@echo off
echo ============================================
echo   Project Nana — Setup Script
echo ============================================
echo.

cd /d "%~dp0"

echo Running setup.ps1 for environment configuration...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   ERROR: Setup failed!
    echo.
    pause
    exit /b %ERRORLEVEL%
)

echo ============================================
echo   Setup complete! Run start.bat to launch.
echo ============================================
pause
