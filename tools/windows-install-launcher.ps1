# Install stable Windows launch scripts without restarting Desktop, workers or writer.
[CmdletBinding()]
param([int]$Port = 4517, [switch]$NoRegister)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer is Windows-only.' }
$destination = Join-Path $env:USERPROFILE '.lark-channel\windows-launcher'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('windows-codex-common.ps1', 'windows-shared-app-server.ps1', 'windows-launch-desktop.ps1')) {
  $source = Join-Path $PSScriptRoot $name
  $target = Join-Path $destination $name
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($target)) {
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.previous" -Force }
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
}
if (-not $NoRegister) {
  & (Join-Path $destination 'windows-shared-app-server.ps1') -Action register -Port $Port
  & (Join-Path $destination 'windows-launch-desktop.ps1') -Install -NoLaunch -Port $Port
}
[pscustomobject]@{ status = 'installed'; directory = $destination; processesRestarted = $false } | ConvertTo-Json -Compress
