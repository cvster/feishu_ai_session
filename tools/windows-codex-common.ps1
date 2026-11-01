# Windows-only helpers. Never imported by Linux launch/deployment paths.
if ($env:OS -ne 'Windows_NT') { throw 'This launcher is Windows-only.' }

function Resolve-WindowsCodexBinary {
  param([string]$Configured, [string]$LocalAppData = $env:LOCALAPPDATA)
  $managed = $Configured -match '[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]codex\.exe$'
  $bare = -not $Configured -or $Configured -match '^codex(\.exe|\.cmd|\.bat)?$'
  # Explicit custom binaries remain pinned, even when unavailable.
  if ($Configured -and -not $managed -and -not $bare) {
    if (-not (Test-Path -LiteralPath $Configured -PathType Leaf)) { throw "Configured custom Codex executable is missing: $Configured" }
    return (Resolve-Path -LiteralPath $Configured).Path
  }
  $root = if ($managed) { Split-Path (Split-Path $Configured -Parent) -Parent } else { Join-Path $LocalAppData 'OpenAI\Codex\bin' }
  $roots = @($root, (Join-Path $LocalAppData 'OpenAI\Codex\bin')) | Select-Object -Unique
  foreach ($directory in $roots) {
    $candidates = @(Get-ChildItem -LiteralPath $directory -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue
    } | Where-Object { -not $_.PSIsContainer -and $_.Length -gt 0 } | Sort-Object LastWriteTimeUtc -Descending)
    if ($candidates.Count) { return $candidates[0].FullName }
  }
  $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw 'Cannot find Codex Desktop CLI. Install/update Codex Desktop or supply a custom executable.'
}

function Get-WindowsConfiguredCodex {
  $file = Join-Path $env:USERPROFILE '.lark-channel\profiles\codex\workers\codex\config.json'
  if (Test-Path -LiteralPath $file) {
    $path = (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).options.binaryPath
    if ($path) { return $path }
  }
  return $env:LARK_CHANNEL_CODEX_BIN
}

function Invoke-WindowsCodexProbe {
  param([string]$Binary, [string]$Arguments)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Binary
  $info.Arguments = $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw 'CLI probe could not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'CLI compatibility probe timed out.' }
    if ($process.ExitCode -ne 0) { throw "CLI compatibility probe failed (exit $($process.ExitCode))." }
    return $stdout.GetAwaiter().GetResult()
  } finally { $process.Dispose() }
}

function Test-WindowsCodexCompatibility {
  param([string]$Binary)
  $version = (Invoke-WindowsCodexProbe $Binary '--version').Trim()
  $server = Invoke-WindowsCodexProbe $Binary 'app-server --help'
  $queue = Invoke-WindowsCodexProbe $Binary 'queue --help'
  if ($server -notmatch '--listen' -or $queue -notmatch '--remote') {
    throw "Codex CLI $version lacks shared app-server/remote queue support. No running service was restarted."
  }
  return [pscustomobject]@{ version = $version; sharedListener = $true; remoteQueue = $true }
}
