# Install stable Windows launch scripts without restarting Desktop, workers or writer.
[CmdletBinding()]
param([ValidateRange(1, 65535)][int]$Port = 4517, [switch]$NoRegister, [switch]$NoShortcut,
  [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer is Windows-only.' }
$destination = Join-Path $env:USERPROFILE '.lark-channel\windows-launcher'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('windows-codex-common.ps1', 'windows-shared-app-server.ps1', 'windows-launch-desktop.ps1', 'windows-shortcut.ps1', 'windows-shortcut.vbs')) {
  $source = Join-Path $PSScriptRoot $name
  $target = Join-Path $destination $name
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($target)) {
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.previous" -Force }
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
}
$assets = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\windows'
foreach ($name in @('codex-blue.ico', 'codex-blue.png')) {
  Copy-Item -LiteralPath (Join-Path $assets $name) -Destination (Join-Path $destination $name) -Force
}
$settingsFile = Join-Path $destination 'launcher.json'
if (Test-Path -LiteralPath $settingsFile) { Copy-Item -LiteralPath $settingsFile -Destination "$settingsFile.previous" -Force }
[IO.File]::WriteAllText($settingsFile, (@{version=1;port=$Port} | ConvertTo-Json -Compress))
$shortcutPath = $null
if (-not $NoShortcut) {
  if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop directory does not exist.' }
  $name = 'Codex ' + [char]0x84dd + [char]0x8272 + [char]0x5171 + [char]0x4eab + [char]0x7248 + '.lnk'
  $shortcutPath = Join-Path $DesktopDirectory $name
  if (Test-Path -LiteralPath $shortcutPath) { Copy-Item -LiteralPath $shortcutPath -Destination "$shortcutPath.previous" -Force }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $shortcut.Arguments = '//B //NoLogo "' + (Join-Path $destination 'windows-shortcut.vbs') + '"'
  $shortcut.WorkingDirectory = $destination
  $shortcut.IconLocation = (Join-Path $destination 'codex-blue.ico') + ',0'
  $shortcut.Description = 'Codex Blue - local shared app-server'
  $shortcut.Save()
}
if (-not $NoRegister) {
  & (Join-Path $destination 'windows-shared-app-server.ps1') -Action register -Port $Port
  & (Join-Path $destination 'windows-launch-desktop.ps1') -Install -NoLaunch -Port $Port
}
[pscustomobject]@{ status = 'installed'; directory = $destination; shortcut = $shortcutPath; processesRestarted = $false } | ConvertTo-Json -Compress
