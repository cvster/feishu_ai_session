# Called only before starting a Codex worker; never restarts a writer or touches queued input.
[CmdletBinding()]
param([string]$Profile = 'codex')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-codex-common.ps1')
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid profile name.' }
$file = Join-Path $env:USERPROFILE ".lark-channel\profiles\$Profile\workers\codex\config.json"
$config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
if ($config.version -ne 1 -or $config.toolId -ne 'codex' -or -not $config.options) { throw 'Invalid worker config.' }
$binary = Resolve-WindowsCodexBinary -Configured $config.options.binaryPath
$owned = Save-WindowsCodexRuntime -Binary $binary
Test-WindowsCodexCompatibility -Binary $owned | Out-Null
if ($config.options.binaryPath -ne $owned) {
  $config.options | Add-Member -MemberType NoteProperty -Name binaryPath -Value $owned -Force
  $temporary = $file + '.' + [Guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Depth 30))
  # Preserve the existing file's ACL through Replace, never print config or credentials.
  [IO.File]::Replace($temporary, $file, "$file.before-owned-runtime")
}
