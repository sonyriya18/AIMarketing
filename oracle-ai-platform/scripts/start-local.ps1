$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectPath
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 24 LTS, then run this launcher again.' }
$nodePath = $nodeCommand.Source
$npmCli = Join-Path (Split-Path -Parent $nodePath) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'Node.js was found, but its npm CLI is missing. Repair the Node.js installation.' }
& $nodePath -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12))process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.12 or newer is required; Node.js 24 LTS is recommended.' }
$lockHash = (Get-FileHash -LiteralPath (Join-Path $projectPath 'package-lock.json') -Algorithm SHA256).Hash
$stampPath = Join-Path $projectPath '.data/install-lock-hash.txt'
$installed = (Test-Path -LiteralPath (Join-Path $projectPath 'node_modules')) -and (Test-Path -LiteralPath $stampPath)
if (-not $installed -or [IO.File]::ReadAllText($stampPath).Trim() -ne $lockHash) {
  & $nodePath $npmCli ci --no-audit --no-fund --cache (Join-Path $projectPath '.data/npm-cache')
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Review the message above and retry.' }
  [IO.Directory]::CreateDirectory((Join-Path $projectPath '.data')) | Out-Null
  [IO.File]::WriteAllText($stampPath,$lockHash)
}
Write-Host 'Open the address printed below (http://localhost:3006 unless .env sets APP_ORIGIN). Keep this window open while using the platform.'
Write-Host 'Responsys v17 runs separately and is not modified; see docs/RESPONSYS_SSO.md to open it through the platform.'
& $nodePath $npmCli run dev
