# Starts all four applications on http://localhost:3006. The platform starts the Responsys
# database and Responsys itself (served at http://responsys.localhost:3006, same sign-in).
$ErrorActionPreference = 'Stop'
$platform = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $platform 'VERSION.txt'
if (Test-Path $versionFile) { Write-Host (Get-Content $versionFile -Raw).Trim() -ForegroundColor Cyan }
$rs = Join-Path $platform 'responsys'
$node = Join-Path $rs 'runtime\node\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Host 'responsys\runtime is missing. Extract every part of the package, then run 1-SETUP.cmd.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
  $node = $cmd.Source
}
if (-not (Test-Path (Join-Path $platform '.env')) -or -not (Test-Path (Join-Path $rs '.env.local'))) {
  Write-Host 'Setup is not finished. Double-click 1-SETUP.cmd first.' -ForegroundColor Red
  Read-Host 'Press Enter to close'; exit 1
}
# Always start this copy fresh: stop whatever holds the platform ports (3006, and 3056 for
# Responsys), including an older copy extracted to another folder, so the browser never shows an
# old version.
$ports = @(3006, 3056)
$owners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($procId in $owners) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    $where = if ($p.Path -like "$platform*") { 'this folder' } else { "another folder: $($p.Path)" }
    Write-Host "Stopping a running copy of the platform ($where)..." -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  } elseif ($p) {
    Write-Host "Port in use by $($p.ProcessName) (process $procId). Close that program, then run 2-START.cmd again." -ForegroundColor Red
    Read-Host 'Press Enter to close'; exit 1
  }
}
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$platform*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host ''
Write-Host 'Starting Responsys, Eloqua, Unity and Infinity...' -ForegroundColor Green
Write-Host 'The browser opens http://localhost:3006 when it is ready. Keep this window open; close it to stop.' -ForegroundColor Yellow
Write-Host ''
Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 180; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3006/health/ready' -TimeoutSec 2 | Out-Null; Start-Process 'http://localhost:3006'; return } catch { Start-Sleep -Seconds 1 }
  }
} | Out-Null
# Office networks: Windows certificates and proxy (see network.ps1).
$env:PLATFORM_NODE = $node
. (Join-Path $PSScriptRoot 'network.ps1')
Set-Location $platform
& $node --import tsx server/local.ts
if ($LASTEXITCODE -ne 0) { Write-Host "The platform stopped (exit code $LASTEXITCODE)." -ForegroundColor Red; Read-Host 'Press Enter to close' }
