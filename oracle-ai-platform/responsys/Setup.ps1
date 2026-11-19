$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node\node.exe'
$pgBin = Join-Path $PSScriptRoot 'runtime\pgsql\bin'
$local = Join-Path $PSScriptRoot '.local'
$pgData = Join-Path $local 'postgres-data'
$passwordFile = Join-Path $local 'postgres-admin-password.txt'
function Assert-Exit([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit code $LASTEXITCODE)." }
}
function Find-FreePort([int]$First) {
    $usedPorts = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
    for ($p=$First; $p -lt $First+100; $p++) {
        if ($usedPorts -contains $p) { continue }
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$p)
        $listener.ExclusiveAddressUse = $true
        try { $listener.Start(); return $p } catch {} finally { $listener.Stop() }
    }
    throw "No available local port near $First."
}
function New-LocalSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes) } finally { $rng.Dispose() }
}
if (-not (Test-Path -LiteralPath $node)) { throw 'Extract the entire ZIP before running Setup.cmd.' }
New-Item -ItemType Directory -Path $local -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    if (-not (Test-Path -LiteralPath $passwordFile)) {
        [IO.File]::WriteAllText($passwordFile,(New-LocalSecret),[Text.UTF8Encoding]::new($false))
    }
    $dbPort = Find-FreePort 5432
    [IO.File]::WriteAllText((Join-Path $local 'database-port.txt'),[string]$dbPort)
    & (Join-Path $pgBin 'initdb.exe') -D $pgData -U postgres "--pwfile=$passwordFile" --auth=scram-sha-256 --encoding=UTF8 --locale=C
    Assert-Exit 'Database initialization'
    Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Value "`nlisten_addresses = 'localhost'`nport = $dbPort"
}
if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'Local database administrator password file is missing. Restore the .local folder from this installation.' }
$dbPort = [int](Get-Content -LiteralPath (Join-Path $local 'database-port.txt') -Raw)
& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $local 'postgres.log') -w start
    Assert-Exit 'Starting PostgreSQL'
}
$adminSecret = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
$previousAdminUrl = $env:PG_ADMIN_URL
try {
    $env:PG_ADMIN_URL = 'postgres://postgres:'+[uri]::EscapeDataString($adminSecret)+'@localhost:'+$dbPort+'/postgres'
    # Piped input prevents optional interactive prompts during the first-time setup.
    '' | & $node --import tsx scripts/setup-local.ts
    Assert-Exit 'Application database setup'
} finally { $env:PG_ADMIN_URL = $previousAdminUrl }
$envPath = Join-Path $PSScriptRoot '.env.local'
$text = [IO.File]::ReadAllText($envPath)
if ($text -notmatch '(?m)^RESPONSYS_CREDENTIALS_FILE=') {
    $text = $text.TrimEnd()+"`nRESPONSYS_CREDENTIALS_FILE=./config/responsys-credentials.json`n"
}
if (-not (Test-Path -LiteralPath (Join-Path $local 'configured.txt'))) {
    $appPort = Find-FreePort 3000
    $text = [regex]::Replace($text,'(?m)^PORT=.*$',"PORT=$appPort")
    $text = [regex]::Replace($text,'(?m)^APP_BASE_URL=.*$',"APP_BASE_URL=http://localhost:$appPort")
    [IO.File]::WriteAllText((Join-Path $local 'configured.txt'),'ready')
}
[IO.File]::WriteAllText($envPath,$text,[Text.UTF8Encoding]::new($false))
Write-Host ''
Write-Host 'Setup complete. Run Start.cmd to open the application.' -ForegroundColor Green
$urlMatch = [regex]::Match($text,'(?m)^APP_BASE_URL=([^\r\n]+)')
if ($urlMatch.Success) { Write-Host ('Local URL: '+$urlMatch.Groups[1].Value.Trim()) }
Write-Host 'Credentials file: config\responsys-credentials.json'
Write-Host 'Use file:main as the server secret reference under Manage connection.'
