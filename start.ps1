<#
  Project Nana — Start the backend server
  Run: .\start.ps1
#>

$projectRoot = $PSScriptRoot
if (-not $projectRoot) { $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition }

$backendDir = Join-Path $projectRoot "backend"
$pythonExe  = Join-Path $backendDir "venv\Scripts\python.exe"
$runScript  = Join-Path $backendDir "run.py"

if (-not (Test-Path $pythonExe)) {
    Write-Host "ERROR: Virtual environment not found. Run .\setup.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Project Nana - Starting backend..." -ForegroundColor Cyan
Write-Host "  Open http://127.0.0.1:8777 in your browser" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

Set-Location $backendDir
& $pythonExe $runScript
