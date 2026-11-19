# One-time setup for Windows (safe to run again). Nothing needs to be installed on the PC:
# Node.js 24 and PostgreSQL 16 come with Responsys in responsys\runtime.
#  1. Checks that every part of the package was extracted.
#  2. Creates the private Responsys database with Responsys's own Setup.ps1 (kept unchanged).
#  3. Creates the platform settings file (.env) and stores the ChatGPT key there only.
# Existing data is never deleted: the platform data (.data) and Responsys data (responsys\.local) are kept.
$ErrorActionPreference = 'Stop'
$platform = Split-Path -Parent $PSScriptRoot
$rs = Join-Path $platform 'responsys'
function Say($text, $color = 'Cyan') { Write-Host ''; Write-Host $text -ForegroundColor $color }
function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
function Set-EnvLine($file, $name, $value) {
  $lines = if (Test-Path $file) { [IO.File]::ReadAllLines($file) } else { @() }
  $found = $false
  $out = foreach ($l in $lines) { if ($l -match "^$name=") { $found = $true; "$name=$value" } else { $l } }
  if (-not $found) { $out = @($out) + "$name=$value" }
  [IO.File]::WriteAllText($file, (($out -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Say '=== Oracle AI Platform setup (Responsys, Eloqua, Unity, Infinity) ===' 'Green'
if ($platform -match '\.zip\\' -or $platform -like "$env:TEMP*") { Fail 'Extract the package to a normal folder first (for example C:\Apps), then run 1-SETUP.cmd from there.' }

Say '[1/4] Checking the package...'
$missing = @()
if (-not (Test-Path (Join-Path $rs 'runtime\node\node.exe'))) { $missing += 'responsys\runtime\node (Node.js)' }
if (-not (Test-Path (Join-Path $rs 'runtime\pgsql\bin\pg_ctl.exe'))) { $missing += 'responsys\runtime\pgsql (PostgreSQL)' }
if (-not (Test-Path (Join-Path $rs 'node_modules\tsx'))) { $missing += 'responsys\node_modules' }
if (-not (Test-Path (Join-Path $platform 'node_modules\tsx'))) { $missing += 'node_modules (platform)' }
if (-not (Test-Path (Join-Path $platform 'dist\index.html'))) { $missing += 'dist (platform screens)' }
if ($missing.Count) {
  Fail ("These folders are missing:`n  - " + ($missing -join "`n  - ") + "`nExtract EVERY part of the package into the same folder (choose 'Yes to all' when asked to merge), then run 1-SETUP.cmd again.")
}
Write-Host '  All parts are present.' -ForegroundColor Green

# Stop copies of the apps started from this folder so Windows does not lock files.
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$platform*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Say '[2/4] Responsys database (private, inside responsys\.local)...'
$rsEnv = Join-Path $rs '.env.local'
if ((Test-Path $rsEnv) -and (Test-Path (Join-Path $rs '.local\postgres-data\PG_VERSION'))) {
  Write-Host '  Already created (kept, with all its data).'
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rs 'Setup.ps1')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $rsEnv)) { Fail 'The Responsys database setup did not finish. See responsys\.local\postgres.log, then run 1-SETUP.cmd again.' }
}

Say '[3/4] Platform settings (.env)...'
$envFile = Join-Path $platform '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $platform '.env.example') $envFile; Write-Host '  Created .env' } else { Write-Host '  Kept your existing .env' }
Set-EnvLine $envFile 'PORT' '3006'
Set-EnvLine $envFile 'APP_ORIGIN' 'http://localhost:3006'
Set-EnvLine $envFile 'RESPONSYS_DIR' ''

Say '[4/4] ChatGPT (OpenAI) for all 4 applications'
Write-Host '  Paste your OpenAI key with RIGHT-CLICK, then press Enter (it is not shown). Press Enter alone to keep the current setting.' -ForegroundColor Yellow
$key = ''
for ($try = 1; $try -le 3; $try++) {
  $secure = Read-Host '  OpenAI key' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $key -or $key -match '^sk-[A-Za-z0-9_\-]{20,}$') { break }
  Write-Host "  That was not a complete key ($($key.Length) characters received). Paste it with right-click and try again." -ForegroundColor Red
  $key = ''
  if ($try -eq 3) { Fail 'The OpenAI key was not received. Run 1-SETUP.cmd again, or put it in the platform .env file as AI_API_KEY=...' }
}
if ($key) {
  Write-Host "  Key received: $($key.Substring(0, 3))...$($key.Substring($key.Length - 4)) ($($key.Length) characters)." -ForegroundColor Green
  $current = ((Get-Content $envFile) | Where-Object { $_ -match '^AI_MODEL=' }) -replace '^AI_MODEL=', ''
  if ($current -notmatch '^[A-Za-z0-9._:-]+$') { $current = '' }
  Write-Host '  Model ID from platform.openai.com/docs/models. Type it (or right-click to paste).' -ForegroundColor Yellow
  $model = ''
  for ($try = 1; $try -le 3; $try++) {
    $model = (Read-Host "  ChatGPT model [$current]").Trim()
    if (-not $model) { $model = $current }
    if ($model -match '^[A-Za-z0-9._:-]+$') { break }
    Write-Host '  A model ID has only letters, digits, dots and dashes. Type it again.' -ForegroundColor Red
    $model = ''
  }
  if (-not $model) { Fail 'A model ID is needed with the key. Run 1-SETUP.cmd again.' }
  Set-EnvLine $envFile 'AI_PROVIDER' 'openai'
  Set-EnvLine $envFile 'AI_MODEL' $model
  Set-EnvLine $envFile 'AI_API_KEY' $key
  Set-EnvLine $envFile 'AI_BASE_URL' ''
  Set-EnvLine $envFile 'AI_TIMEOUT_MS' '90000'
  Set-EnvLine $envFile 'RESPONSYS_SHARE_AI' 'true'
  Say "  ChatGPT is set ($model). Responsys receives the same key when the platform starts it." 'Green'
} else {
  Say '  Key unchanged. Without a key the apps give rule-based answers (clearly labelled).' 'Yellow'
}

Say 'Setup complete. Now double-click 2-START.cmd.' 'Green'
Read-Host 'Press Enter to close'
