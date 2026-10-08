<#
.SYNOPSIS
  Upload Homebuyer Market Lens to the server and (after first-time setup) restart it.

.EXAMPLE
  .\deploy\upload.ps1 -Server root@203.0.113.10
.EXAMPLE
  .\deploy\upload.ps1 -Server root@example.com -KeyFile $HOME\.ssh\ionos_ed25519

  Uses the ssh and scp commands built into Windows 10 and 11. Uploads only the code; the server
  downloads its own data. Local data, the virtual environment and IDE files are never sent.
#>
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$KeyFile
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$items = @('server.py', 'ingest.py', 'catalog.py', 'requirements.txt', 'README.md', 'static', 'deploy')
foreach ($item in $items) {
    if (-not (Test-Path (Join-Path $root $item))) { throw "Missing $item in $root" }
}

$tarball = Join-Path $env:TEMP 'homebuyer-lens.tar.gz'
Write-Host "Packaging the site..."
# Windows' own tar, by full path: Git for Windows also ships a tar.exe that can't handle C:\ paths.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -czf $tarball -C $root --exclude=__pycache__ --exclude=_frame.html @items
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

$sshOptions = @()
if ($KeyFile) { $sshOptions = @('-i', $KeyFile) }

Write-Host "Uploading to $Server..."
& scp @sshOptions $tarball (Join-Path $PSScriptRoot 'install_update.sh') "${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }
Remove-Item $tarball

Write-Host "Installing on the server..."
& ssh @sshOptions $Server "sed -i 's/\r$//' /tmp/install_update.sh && bash /tmp/install_update.sh; status=`$?; rm -f /tmp/install_update.sh; exit `$status"
if ($LASTEXITCODE -ne 0) { throw "Install on the server failed (see messages above)." }
