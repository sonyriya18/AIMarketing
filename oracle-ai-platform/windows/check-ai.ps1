# Checks that ChatGPT (or Gemini) can be reached from this PC, with the same settings as 2-START.cmd.
$ErrorActionPreference = 'Continue'
$platform = Split-Path -Parent $PSScriptRoot
$node = Join-Path $platform 'responsys\runtime\node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$env:PLATFORM_NODE = $node
. (Join-Path $PSScriptRoot 'network.ps1')
Set-Location $platform
Write-Host ''
& $node --import tsx scripts/check-ai.ts
Write-Host ''
Read-Host 'Press Enter to close'
