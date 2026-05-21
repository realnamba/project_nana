<#
  Project Nana — PowerShell Setup Script
  Run this in PowerShell: .\setup.ps1
#>

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
if (-not $projectRoot) { $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    Project Nana  -  Setup Script" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

$backendDir = Join-Path $projectRoot "backend"
$venvDir    = Join-Path $backendDir "venv"
$pipExe     = Join-Path $venvDir "Scripts\pip.exe"
$pythonExe  = Join-Path $venvDir "Scripts\python.exe"

# ── Step 1: Find system Python ──────────────────────────────────────
Write-Host "[1/4] Locating Python..." -ForegroundColor Yellow
$sysPython = $null
$candidates = @(
    "C:\Users\LENOV\AppData\Local\Programs\Python\Python312\python.exe",
    "C:\Python312\python.exe",
    "C:\Program Files\Python312\python.exe"
)
foreach ($p in $candidates) {
    if (Test-Path $p) { $sysPython = $p; break }
}
if (-not $sysPython) {
    # Try PATH
    $sysPython = (Get-Command python -ErrorAction SilentlyContinue).Source
}
if (-not $sysPython) {
    Write-Host "  ERROR: Python not found! Install from https://python.org" -ForegroundColor Red
    exit 1
}
Write-Host "  Found: $sysPython" -ForegroundColor Green

# ── Step 2: Create venv ─────────────────────────────────────────────
if (-not (Test-Path $pythonExe)) {
    Write-Host "[2/4] Creating virtual environment..." -ForegroundColor Yellow
    & $sysPython -m venv $venvDir
    Write-Host "  Done." -ForegroundColor Green
} else {
    Write-Host "[2/4] Virtual environment already exists." -ForegroundColor Green
}

# ── Step 3: Install packages ────────────────────────────────────────
Write-Host "[3/4] Installing Python packages..." -ForegroundColor Yellow
& $pipExe install fastapi uvicorn[standard] httpx sse-starlette pydantic aiosqlite Pillow python-dotenv mss
Write-Host "  Done." -ForegroundColor Green

# ── Step 4: Pull Ollama model ───────────────────────────────────────
Write-Host "[4/4] Pulling qwen2.5-coder:3b from Ollama..." -ForegroundColor Yellow
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaCmd) {
    ollama pull qwen2.5-coder:3b
    Write-Host "  Done." -ForegroundColor Green
} else {
    Write-Host "  WARNING: Ollama not found. Install from https://ollama.com" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    Setup complete!" -ForegroundColor Green
Write-Host "    Run:  .\start.ps1  to launch the app" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
