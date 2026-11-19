# Office networks: lets Node.js reach the AI service the way the browser does.
# 1) Trust the Windows certificate store (company security software that checks secure traffic).
# 2) Use the Windows proxy setting when one is set and HTTPS_PROXY is not already given.
$useSystemCa = $false
$nodeExe = if ($env:PLATFORM_NODE) { $env:PLATFORM_NODE } else { 'node' }
try { & $nodeExe --use-system-ca -e 0 2>$null; $useSystemCa = ($LASTEXITCODE -eq 0) } catch { $useSystemCa = $false }
if ($useSystemCa -and ("$env:NODE_OPTIONS" -notmatch 'use-system-ca')) {
  $env:NODE_OPTIONS = ("$env:NODE_OPTIONS --use-system-ca").Trim()
}
if (-not $env:HTTPS_PROXY) {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
    $p = [string]$ie.ProxyServer
    if ($p -match 'https=([^;]+)') { $p = $Matches[1] } elseif ($p -match 'http=([^;]+)') { $p = $Matches[1] } elseif ($p -match ';') { $p = ($p -split ';')[0] }
    if ($p -notmatch '://') { $p = 'http://' + $p }
    $env:HTTPS_PROXY = $p
    $env:HTTP_PROXY = $p
    Write-Host "Using the Windows proxy setting: $p" -ForegroundColor Yellow
  } elseif ($ie -and $ie.AutoConfigURL) {
    Write-Host 'This PC uses an automatic proxy script. If ChatGPT cannot be reached, ask IT for the proxy address and set HTTPS_PROXY in the platform .env.' -ForegroundColor Yellow
  }
}
if ($env:HTTPS_PROXY) {
  $env:NO_PROXY = 'localhost,127.0.0.1,::1,.localhost'
  $env:NODE_USE_ENV_PROXY = '1'
}
