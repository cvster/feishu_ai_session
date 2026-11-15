# Register windowless bridge/worker tasks. Does not stop or start existing processes.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BridgeRelease,
  [string]$CodexWorkerRelease,
  [string]$PiWorkerRelease,
  [string]$NodePath = (Get-Command node.exe -CommandType Application).Source,
  [string]$Profile = 'codex',
  [switch]$NoRegister
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only.' }
. (Join-Path $PSScriptRoot 'windows-codex-common.ps1')
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid profile.' }
$homeDir = Join-Path $env:USERPROFILE '.lark-channel'
$destination = Join-Path $homeDir 'windows-launcher'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('windows-codex-common.ps1','windows-prepare-codex.ps1')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $destination $name) -Force
}
$source = Join-Path $PSScriptRoot 'windows-service-host.cs'
$hostExe = Get-WindowsServiceHost -Source $source
function Quote-Native([string]$Value) {
  if ($Value -match '["\r\n]' -or $Value.EndsWith('\')) { throw 'Invalid executable argument.' }
  return '"' + $Value + '"'
}
$items = @(@{role='bridge';release=$BridgeRelease;task="LarkChannelBridge.Bot.$Profile";args='run'})
if ($CodexWorkerRelease) { $items += @{role='worker-codex';release=$CodexWorkerRelease;task="LarkChannelBridge.Worker.codex.$Profile";args='worker run --tool codex'} }
if ($PiWorkerRelease) { $items += @{role='worker-pi';release=$PiWorkerRelease;task="LarkChannelBridge.Worker.pi.$Profile";args='worker run --tool pi'} }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($item in $items) {
  $release = (Resolve-Path -LiteralPath $item.release).Path
  $entry = Join-Path $release 'bin\lark-channel-bridge.mjs'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Release entry missing: $entry" }
  $logs = Join-Path $homeDir "profiles\$Profile\logs\$($item.role)"
  $command = [ordered]@{ executable=$NodePath; directory=$release; channelHome=$homeDir;
    arguments=(Quote-Native $entry) + ' ' + $item.args + ' --profile ' + $Profile + ' --config ' + (Quote-Native (Join-Path $homeDir 'config.json'));
    stdout=(Join-Path $logs 'stdout.log'); stderr=(Join-Path $logs 'stderr.log') }
  if ($item.role -eq 'worker-codex') {
    $command.prepare = @{ executable=(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'); directory=$destination;
      arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Native (Join-Path $destination 'windows-prepare-codex.ps1')) + ' -Profile ' + $Profile;
      stdout=(Join-Path $logs 'prepare-stdout.log'); stderr=(Join-Path $logs 'prepare-stderr.log') }
  }
  $file = Join-Path $destination "$($item.role)-$Profile.json"
  if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination "$file.previous" -Force }
  [IO.File]::WriteAllText($file, ($command | ConvertTo-Json -Depth 5))
  if (-not $NoRegister) {
    $old = Get-ScheduledTask -TaskName $item.task -ErrorAction SilentlyContinue
    if ($old) { Export-ScheduledTask -TaskName $item.task | Set-Content -LiteralPath (Join-Path $destination "$($item.role)-$Profile.task.previous.xml") -Encoding Unicode }
    $action = New-ScheduledTaskAction -Execute $hostExe -Argument (Quote-Native $file) -WorkingDirectory $destination
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $item.task -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
  }
}
[pscustomobject]@{hostExecutable=$hostExe;tasks=@($items | ForEach-Object task);processesRestarted=$false} | ConvertTo-Json -Compress
