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
  [switch]$NoLaunch,
  [switch]$Check,
  [int]$Port = 4517
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-codex-common.ps1')
$taskName = 'LarkChannelBridge.Desktop'
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  return
}
$desktop = (Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1).InstallLocation
if (-not $desktop) { throw 'Codex Desktop is not installed for this user.' }
$exe = Join-Path $desktop 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Desktop executable not found: $exe" }

if ($Install) {
  $script = $PSCommandPath
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Port $Port" `
    -WorkingDirectory (Split-Path $PSCommandPath -Parent)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Start Codex Desktop attached to the local shared app-server' -Force |
    Select-Object TaskName, State | Format-List
}

if ($NoLaunch) { return }
if ($Check) {
  & (Join-Path $PSScriptRoot 'windows-shared-app-server.ps1') -Action check -Port $Port
  return
}

# Start is idempotent and serialized. Never restart a healthy older writer.
& (Join-Path $PSScriptRoot 'windows-shared-app-server.ps1') -Action start -Port $Port
$env:CODEX_APP_SERVER_WS_URL = "ws://127.0.0.1:$Port"
$running = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited })
if ($running.Count -gt 0) {
  $ids = @($running | Select-Object -ExpandProperty Id)
  $connections = @(Get-NetTCPConnection -State Established -RemoteAddress 127.0.0.1 -RemotePort $Port -ErrorAction SilentlyContinue |
    Where-Object { $ids -contains $_.OwningProcess })
  if (-not $connections.Count) { throw 'Codex Desktop is already running without this shared endpoint. Close it yourself, then use this shortcut again. No process was stopped.' }
}
Start-Process -FilePath $exe
[pscustomobject]@{ status = 'opened'; url = $env:CODEX_APP_SERVER_WS_URL; desktop = $exe } | ConvertTo-Json -Compress
