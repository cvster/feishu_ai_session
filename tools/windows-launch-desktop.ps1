# Launch Codex Desktop attached to the local shared app-server.
#
# Codex Desktop on Windows always spawns its own stdio app-server unless
# CODEX_APP_SERVER_WS_URL points at an external endpoint. A user environment
# variable is not enough for a process started by the installer/tray, so this
# launcher sets it for the desktop process explicitly.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-launch-desktop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-launch-desktop.ps1 -Install
#
# -Install registers a per-user logon task that starts the shared app-server and
# then the desktop through this script.
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [int]$Port = 4517
)

$ErrorActionPreference = 'Stop'
$taskName = 'LarkChannelBridge.Desktop'
$desktop = (Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1).InstallLocation
if (-not $desktop) { throw 'Codex Desktop is not installed for this user.' }
$exe = Join-Path $desktop 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Desktop executable not found: $exe" }

$running = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited })
if ($running.Count -gt 0) {
  [pscustomobject]@{ status = 'already-running'; processes = $running.Count
    url = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Process') } | ConvertTo-Json -Compress
  return
}

$env:CODEX_APP_SERVER_WS_URL = "ws://127.0.0.1:$Port"
Start-Process -FilePath $exe
[pscustomobject]@{ status = 'started'; url = $env:CODEX_APP_SERVER_WS_URL } | ConvertTo-Json -Compress

if ($Install) {
  $script = $PSCommandPath
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Port $Port" `
    -WorkingDirectory (Split-Path $PSCommandPath -Parent)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
    -Description 'Start Codex Desktop attached to the local shared app-server' -Force |
    Select-Object TaskName, State | Format-List
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  [pscustomobject]@{ status = 'removed'; task = $taskName } | ConvertTo-Json -Compress
}
