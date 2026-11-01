<#
.SYNOPSIS
  Run one local Codex app-server on a loopback WebSocket endpoint for Codex
  Desktop and the Feishu bridge worker to share.

.DESCRIPTION
  Codex Desktop on Windows always spawns its own stdio app-server; its bundled
  launch code excludes Windows from the local daemon path. This script starts the
  same CLI in `--listen ws://127.0.0.1:<port>` mode so both clients can attach to
  one execution endpoint.

  Safety:
  - Binds loopback only; the endpoint is unauthenticated by design because the
    Codex Desktop WebSocket client injects bearer headers for cloud hosts only.
    Never point this at a non-loopback address.
  - Only manages the process recorded in its own state file. It never stops
    Codex Desktop, other app-servers, or the bridge.
  - `stop` refuses to kill a process whose command line does not match this
    state file.

.PARAMETER Action
  start | stop | restart | status | install | uninstall

.PARAMETER Port
  Loopback TCP port. Default 4517.

.PARAMETER CodexPath
  codex.exe to run. Default: the versioned binary used by the local profile.

.PARAMETER CodexHome
  CODEX_HOME to serve. Default: %USERPROFILE%\.codex (the desktop's own home).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action start

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action install
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'check', 'register', 'install', 'uninstall')]
  [string]$Action = 'status',
  [int]$Port = 4517,
  [string]$CodexPath,
  [string]$CodexHome
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-codex-common.ps1')
$stateDir = Join-Path $env:USERPROFILE '.lark-channel\shared-app-server'
$stateFile = Join-Path $stateDir 'state.json'
$stdoutLog = Join-Path $stateDir 'stdout.log'
$stderrLog = Join-Path $stateDir 'stderr.log'
$taskName = 'LarkChannelBridge.SharedAppServer'

function Resolve-CodexBinary {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw "codex.exe not found: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }
  return Resolve-WindowsCodexBinary -Configured (Get-WindowsConfiguredCodex)
}

function Read-State {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  try { return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-Ready {
  param([int]$TargetPort)
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/readyz" -TimeoutSec 3 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch { return $false }
}

function Get-OwnedProcess {
  param($State)
  if (-not $State -or -not $State.pid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $expected = "ws://127.0.0.1:$($State.port)"
  if ($process.CommandLine -notmatch [regex]::Escape($expected)) { return $null }
  if ($process.ExecutablePath -ne $State.codexPath) { return $null }
  return $process
}

function Wait-Ready {
  param([int]$TargetPort, [int]$TimeoutSeconds = 40)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Ready -TargetPort $TargetPort) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Start-Server {
  # Logon tasks and the desktop shortcut can start simultaneously.
  $mutex = New-Object System.Threading.Mutex($false, "Local\LarkCodexShared-$env:USERNAME-$Port")
  $held = $false
  try {
    try { $held = $mutex.WaitOne(45000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another shared app-server launch is still in progress.' }
    Start-ServerCore
  } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Start-ServerCore {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $existing = Read-State
  if ($existing) {
    $owned = Get-OwnedProcess -State $existing
    if ($owned) {
      if (Test-Ready -TargetPort $existing.port) {
        if ($existing.port -ne $Port) { throw "Shared server is on port $($existing.port), not requested port $Port. It was not restarted." }
        $candidate = Resolve-CodexBinary -Explicit $CodexPath
        [pscustomobject]@{ status = 'already-running'; pid = $owned.ProcessId; url = "ws://127.0.0.1:$($existing.port)";
          codex = $existing.codexPath; discoveredCodex = $candidate; updateAvailable = $candidate -ne $existing.codexPath } | ConvertTo-Json -Compress
        if ($candidate -ne $existing.codexPath) { Write-Warning 'A newer Codex CLI was discovered. The running shared server is preserved; the new CLI is used on its next start.' }
        return
      }
      throw "Recorded app-server pid $($owned.ProcessId) is running but not ready on port $($existing.port). Run -Action stop first."
    }
    Remove-Item -LiteralPath $stateFile -Force
  }

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listener) { throw "Port $Port is already in use by pid $($listener[0].OwningProcess). Choose another -Port." }

  $binary = Resolve-CodexBinary -Explicit $CodexPath
  $compatibility = Test-WindowsCodexCompatibility -Binary $binary
  $resolvedHome = if ($CodexHome) { $CodexHome } else { Join-Path $env:USERPROFILE '.codex' }
  if (-not (Test-Path -LiteralPath $resolvedHome)) { throw "CODEX_HOME does not exist: $resolvedHome" }

  # The desktop normally injects this when it spawns app-server; a standalone
  # server needs it for Windows sandboxed command execution.
  if (-not $env:CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY) {
    $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($package) { $env:CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY = $package.PackageFamilyName }
  }
  $env:CODEX_HOME = $resolvedHome
  if (-not $env:CODEX_SQLITE_HOME) { $env:CODEX_SQLITE_HOME = Join-Path $resolvedHome 'sqlite' }
  $env:LOG_FORMAT = 'json'
  if (-not $env:RUST_LOG) { $env:RUST_LOG = 'warn' }

  $arguments = @(
    '-c', 'features.code_mode_host=true',
    'app-server',
    '--listen', "ws://127.0.0.1:$Port",
    '--analytics-default-enabled',
    '-c', 'features.prefer_mxc=true',
    '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'
  )
  $process = Start-Process -FilePath $binary -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

  $state = [pscustomobject]@{
    version = 1
    pid = $process.Id
    port = $Port
    url = "ws://127.0.0.1:$Port"
    codexPath = $binary
    codexVersion = $compatibility.version
    codexHome = $resolvedHome
    startedAt = (Get-Date).ToString('o')
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8

  if (-not (Wait-Ready -TargetPort $Port)) {
    $tail = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 20) -join "`n" } else { '' }
    throw "Shared app-server did not become ready on port $Port. $tail"
  }
  [pscustomobject]@{ status = 'started'; pid = $process.Id; url = $state.url; codex = $binary; codexHome = $resolvedHome } | ConvertTo-Json -Compress
}

function Stop-Server {
  $state = Read-State
  if (-not $state) { [pscustomobject]@{ status = 'not-running' } | ConvertTo-Json -Compress; return }
  $process = Get-OwnedProcess -State $state
  if (-not $process) {
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ status = 'not-running'; detail = 'state file removed; recorded pid no longer matches this endpoint' } | ConvertTo-Json -Compress
    return
  }
  # Only this app-server and its children; never the desktop or the bridge.
  & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{ status = 'stopped'; pid = $process.ProcessId } | ConvertTo-Json -Compress
}

function Show-Status {
  $state = Read-State
  if (-not $state) { [pscustomobject]@{ status = 'not-running' } | ConvertTo-Json -Compress; return }
  $process = Get-OwnedProcess -State $state
  $ready = Test-Ready -TargetPort $state.port
  $desktopConnections = @(Get-NetTCPConnection -State Established -RemotePort $state.port -ErrorAction SilentlyContinue |
    ForEach-Object {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
      [pscustomobject]@{ pid = $_.OwningProcess; name = $owner.Name }
    } | Where-Object { $_.name -eq 'ChatGPT.exe' })
  [pscustomobject]@{
    status = if ($process) { 'running' } else { 'dead' }
    pid = $state.pid
    url = $state.url
    ready = $ready
    codex = $state.codexPath
    codexVersion = $state.codexVersion
    discoveredCodex = (Resolve-CodexBinary -Explicit $CodexPath)
    updateAvailable = (Resolve-CodexBinary -Explicit $CodexPath) -ne $state.codexPath
    codexHome = $state.codexHome
    desktopConnections = $desktopConnections
    task = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State)
  } | ConvertTo-Json -Compress -Depth 4
}

function Install-AutoStart {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $script = $PSCommandPath
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Action start -Port $Port" `
    -WorkingDirectory (Split-Path $PSCommandPath -Parent)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Local shared Codex app-server for Desktop and the Feishu bridge' -Force | Select-Object TaskName, State | Format-List
}

function Uninstall-AutoStart {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  [pscustomobject]@{ status = 'auto-start-removed'; task = $taskName } | ConvertTo-Json -Compress
}

switch ($Action) {
  'start' { Start-Server }
  'stop' { Stop-Server }
  'restart' { Stop-Server; Start-Server }
  'status' { Show-Status }
  'check' {
    $binary = Resolve-CodexBinary -Explicit $CodexPath
    $compatibility = Test-WindowsCodexCompatibility -Binary $binary
    [pscustomobject]@{ status = 'checked'; codex = $binary; compatibility = $compatibility;
      ready = (Test-Ready -TargetPort $Port); url = "ws://127.0.0.1:$Port" } | ConvertTo-Json -Compress -Depth 4
  }
  'register' { Install-AutoStart }
  'install' { Start-Server; Install-AutoStart; Show-Status }
  'uninstall' { Uninstall-AutoStart; Show-Status }
}
