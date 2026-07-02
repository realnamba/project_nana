param(
    [switch]$SkipModels,
    [string]$Model = ""
)

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

# 1. Gather all potential command candidates
$cmds = @()

# Add launcher absolute path if found in standard launcher directories
$launcherPaths = @(
    "C:\Users\LENOV\AppData\Local\Programs\Python\Launcher\py.exe",
    "C:\Windows\py.exe",
    "py"
)
foreach ($lp in $launcherPaths) {
    if (Test-Path $lp) {
        $cmds += '"' + $lp + '" -3.14'
        $cmds += '"' + $lp + '" -3.13'
        $cmds += '"' + $lp + '" -3.12'
        $cmds += '"' + $lp + '" -3'
    } elseif ($lp -eq "py" -and (Get-Command "py" -ErrorAction SilentlyContinue)) {
        $cmds += "py -3.14"
        $cmds += "py -3.13"
        $cmds += "py -3.12"
        $cmds += "py -3"
    }
}

# Add standard commands if they are on PATH
if (Get-Command "python" -ErrorAction SilentlyContinue) { $cmds += "python" }
if (Get-Command "python3" -ErrorAction SilentlyContinue) { $cmds += "python3" }

# 2. Dynamically scan standard directories for python.exe
$searchRoots = @(
    "C:\Users\LENOV\AppData\Local\Programs\Python",
    "C:\Python",
    "C:\Program Files\Python",
    "C:\Program Files (x86)\Python"
)
foreach ($root in $searchRoots) {
    if (Test-Path $root) {
        try {
            $dirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue
            foreach ($d in $dirs) {
                $pyCandidate = Join-Path $d.FullName "python.exe"
                if (Test-Path $pyCandidate) {
                    $cmds += '"' + $pyCandidate + '"'
                }
            }
        } catch {}
    }
}

# Run check on all gathered candidates
foreach ($c in $cmds) {
    # Parse executable and arguments safely
    $exe = $null
    $args = $null
    
    if ($c -match '^"([^"]+)"\s*(.*)$') {
        $exe = $Matches[1]
        $args = $Matches[2]
    } elseif ($c -match '^(.*?\.exe)\s+(.*)$' -or $c -match '^(py)\s+(.*)$') {
        $exe = $Matches[1]
        $args = $Matches[2]
    } else {
        $exe = $c
        $args = $null
    }
    
    $exe = $exe.Trim()
    if ($args) { $args = $args.Trim() }

    # Check existence
    if (-not (Test-Path $exe) -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        continue
    }

    $rawOutput = $null
    try {
        if ($args) {
            # Run using invoke-expression or call operator
            $rawOutput = & $exe ($args -split ' ') --version 2>&1
        } else {
            $rawOutput = & $exe --version 2>&1
        }
    } catch {
        continue
    }

    if ($rawOutput -and $rawOutput.ToString().Trim() -match 'Python\s+(\d+)\.(\d+)\.(\d+)') {
        $verStr = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
        try {
            $foundVer = [version]$verStr
            $meets = $foundVer -ge [version]"3.10.0"
            Write-Host "[setup] Tried '$c --version' -> raw output: ""$($rawOutput.ToString().Trim())"" -> parsed: $verStr -> meets 3.10+? $meets" -ForegroundColor Gray
            
            if ($meets) {
                $pathOutput = $null
                try {
                    if ($args) {
                        $pathOutput = & $exe ($args -split ' ') -c "import sys; print(sys.executable)" 2>$null
                    } else {
                        $pathOutput = & $exe -c "import sys; print(sys.executable)" 2>$null
                    }
                } catch {}

                if ($pathOutput) {
                    $resolvedPath = $pathOutput.ToString().Trim()
                    if (Test-Path $resolvedPath) {
                        $sysPython = $resolvedPath
                        break
                    }
                }
            }
        } catch {
            Write-Host "[setup] Tried '$c --version' -> failed to parse version: $verStr" -ForegroundColor Yellow
        }
    } else {
        $rawStr = if ($rawOutput) { $rawOutput.ToString().Trim() } else { "empty" }
        Write-Host "[setup] Tried '$c --version' -> raw output: ""$rawStr"" -> parsed: failed" -ForegroundColor Gray
    }
}

# Final fallback to standard paths
if (-not $sysPython) {
    $fallbackCandidates = @(
        "C:\Users\LENOV\AppData\Local\Programs\Python\Python314\python.exe",
        "C:\Users\LENOV\AppData\Local\Programs\Python\Python312\python.exe",
        "C:\Python312\python.exe",
        "C:\Program Files\Python312\python.exe"
    )
    foreach ($p in $fallbackCandidates) {
        if (Test-Path $p) {
            $sysPython = $p
            Write-Host "[setup] Fallback to standard path -> Found: $p" -ForegroundColor Gray
            break
        }
    }
}

if (-not $sysPython) {
    Write-Host "  ERROR: Python 3.10+ not found! Install from https://python.org" -ForegroundColor Red
    exit 1
}
Write-Host "  Found: $sysPython" -ForegroundColor Green
Write-Host "[setup] Found Python at $sysPython" -ForegroundColor Green

# ── Step 2: Create venv ─────────────────────────────────────────────
$venvRunnable = $false
if (Test-Path $pythonExe) {
    try {
        $testOut = & $pythonExe -c "print('ok')" 2>$null
        if ($testOut -eq "ok") {
            $venvRunnable = $true
        }
    } catch {}
}

if (-not $venvRunnable) {
    Write-Host "[2/4] Creating virtual environment (missing or broken)..." -ForegroundColor Yellow
    if (Test-Path $venvDir) {
        Remove-Item -Path $venvDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    & $sysPython -m venv $venvDir
    
    # Verify new venv works
    $verifyRunnable = $false
    if (Test-Path $pythonExe) {
        try {
            $testOut = & $pythonExe -c "print('ok')" 2>$null
            if ($testOut -eq "ok") {
                $verifyRunnable = $true
            }
        } catch {}
    }
    
    if ($verifyRunnable) {
        Write-Host "  Done." -ForegroundColor Green
        Write-Host "[setup] venv created: success" -ForegroundColor Green
    } else {
        Write-Host "  ERROR: Failed to create or run virtual environment!" -ForegroundColor Red
        Write-Host "[setup] venv created: failure" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[2/4] Virtual environment is valid and ready." -ForegroundColor Green
    Write-Host "[setup] venv created: success (already exists and valid)" -ForegroundColor Green
}

# ── Step 3: Install packages ────────────────────────────────────────
Write-Host "[3/4] Installing Python packages..." -ForegroundColor Yellow
& $pipExe install fastapi uvicorn[standard] httpx sse-starlette pydantic aiosqlite Pillow python-dotenv mss lancedb sentence-transformers
Write-Host "  Done." -ForegroundColor Green

# ── Step 4: Pull Ollama model ───────────────────────────────────────
$defaultModel = "qwen2.5-coder:3b"
$registryPath = Join-Path $projectRoot "config\model_registry.json"
if (Test-Path $registryPath) {
    try {
        $reg = Get-Content $registryPath -Raw | ConvertFrom-Json
        if ($reg -is [array] -and $reg.Count -gt 0) {
            if ($reg[0].id) {
                $defaultModel = $reg[0].id
            } elseif ($reg[0].name) {
                $defaultModel = $reg[0].name
            }
        } elseif ($reg -is [PSCustomObject]) {
            if ($reg.id) {
                $defaultModel = $reg.id
            } elseif ($reg.name) {
                $defaultModel = $reg.name
            }
        }
    } catch {}
}

# Normalize model name for Ollama if it looks like a filepath/gguf
if ($defaultModel -match '([^/\\]+)\.gguf$') {
    $cleanName = $Matches[1]
    if ($cleanName -match 'qwen2\.5-coder-(\d+)b') {
        $defaultModel = "qwen2.5-coder:$($Matches[1])b"
    } elseif ($cleanName -match 'qwen2\.5-(\d+)b') {
        $defaultModel = "qwen2.5:$($Matches[1])b"
    } elseif ($cleanName -match 'llama-3\.2-(\d+)b') {
        $defaultModel = "llama3.2:$($Matches[1])b"
    } else {
        $defaultModel = $cleanName
    }
}

if ($Model) {
    $modelToPull = $Model
} else {
    $modelToPull = $defaultModel
}

Write-Host "[4/4] Local model setup (optional)" -ForegroundColor Yellow

$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCmd) {
    Write-Host "  Ollama not found - skipping model pull. Install from https://ollama.com if you want local models." -ForegroundColor Yellow
} elseif ($SkipModels) {
    Write-Host "  Skipping model pull (SkipModels switch was specified)." -ForegroundColor Green
} else {
    $shouldPull = $false
    if ($Model) {
        $shouldPull = $true
    } else {
        Write-Host "  Pull $modelToPull now via Ollama? This is a ~1.9GB download."
        $response = Read-Host "  [y/N]"
        if ($response -and $response.Trim().ToLower() -eq 'y') {
            $shouldPull = $true
        }
    }

    if ($shouldPull) {
        Write-Host "  Pulling $modelToPull from Ollama..." -ForegroundColor Yellow
        ollama pull $modelToPull
        Write-Host "  Done." -ForegroundColor Green
    } else {
        Write-Host "  Skipped model pull." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    Setup complete!" -ForegroundColor Green
Write-Host "    Run:  .\start.ps1  to launch the app" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
