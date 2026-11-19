$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env.local')) { & (Join-Path $PSScriptRoot 'Setup.ps1') }
$pgBin = Join-Path $PSScriptRoot 'runtime\pgsql\bin'
$data = Join-Path $PSScriptRoot '.local\postgres-data'
& (Join-Path $pgBin 'pg_ctl.exe') -D $data status *> $null
if ($LASTEXITCODE -ne 0) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $data -l (Join-Path $PSScriptRoot '.local\postgres.log') -w start
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL could not start. Check .local\postgres.log.' }
}
$envText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '.env.local'))
$match = [regex]::Match($envText,'(?m)^APP_BASE_URL=([^\r\n]+)')
$url = if ($match.Success) { $match.Groups[1].Value.Trim() } else { 'http://localhost:3000' }
try {
    if ((Invoke-RestMethod ($url+'/api/health/ready') -TimeoutSec 3).status -eq 'ready') {
        Write-Host "The application is already running at $url"
        exit 0
    }
} catch {}
if (-not $env:HTTPS_PROXY) {
    $probe = [uri]'https://responsys.ocs.oraclecloud.com'
    $proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($probe)
    if ($proxy.Authority -ne $probe.Authority) { $env:HTTPS_PROXY = $proxy.AbsoluteUri }
}
$env:NODE_USE_ENV_PROXY = '1'
$env:NODE_ENV = 'development'
$env:NO_PROXY = (@($env:NO_PROXY,'localhost,127.0.0.1,::1') | Where-Object { $_ }) -join ','
Write-Host "Open $url in your browser. Keep this window open while using the application." -ForegroundColor Green
& (Join-Path $PSScriptRoot 'runtime\node\node.exe') --use-system-ca --import tsx server/index.ts
if ($LASTEXITCODE -ne 0) { throw "Application exited with code $LASTEXITCODE." }
