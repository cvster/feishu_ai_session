# Hidden shortcut entry. Settings contain only the shared loopback port.
$ErrorActionPreference = 'Stop'
try {
  $settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'launcher.json') -Raw | ConvertFrom-Json
  $port = $settings.port
  if ($port -isnot [int] -and $port -isnot [long] -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid shared server port.' }
  & (Join-Path $PSScriptRoot 'windows-launch-desktop.ps1') -Port $port | Out-Null
  exit 0
} catch {
  $_ | Out-String | Out-File -LiteralPath (Join-Path $PSScriptRoot 'launch-error.log') -Encoding utf8
  exit 1
}
