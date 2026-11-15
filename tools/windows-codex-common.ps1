# Windows-only helpers. Never imported by Linux launch/deployment paths.
if ($env:OS -ne 'Windows_NT') { throw 'This launcher is Windows-only.' }
# Windows PowerShell can inherit PowerShell 7's module path through a parent app.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath

function Get-WindowsServiceHost {
  param([string]$Source = (Join-Path $PSScriptRoot 'windows-service-host.cs'))
  if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $common = (Join-Path $PSScriptRoot 'windows-codex-common.ps1').Replace("'", "''")
    $escapedSource = $Source.Replace("'", "''")
    $command = ". '$common'; Get-WindowsServiceHost -Source '$escapedSource'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $output = & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw 'Windowless host compilation failed.' }
    return "$output".Trim()
  }
  $directory = Join-Path $env:USERPROFILE '.lark-channel\windows-launcher'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $hash = (Get-FileHash -LiteralPath $Source).Hash.Substring(0,16).ToLowerInvariant()
  $exe = Join-Path $directory "service-host-$hash.exe"
  if (-not (Test-Path -LiteralPath $exe)) { Add-Type -Path $Source -OutputAssembly $exe -OutputType WindowsApplication -ReferencedAssemblies 'System.Web.Extensions.dll' }
  return $exe
}

$script:CodexRuntimeFiles = @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')
function Test-WindowsCodexRuntime {
  param([string]$Directory)
  foreach ($name in $script:CodexRuntimeFiles) {
    $file = Get-Item -LiteralPath (Join-Path $Directory $name) -ErrorAction SilentlyContinue
    if (-not $file -or $file.PSIsContainer -or $file.Length -eq 0) { return $false }
  }
  return $true
}

function Save-WindowsCodexRuntime {
  param([string]$Binary, [string]$CacheRoot = (Join-Path $env:USERPROFILE '.lark-channel\codex-runtime'))
  $source = Split-Path $Binary -Parent
  if (-not (Test-WindowsCodexRuntime $source)) { throw "Incomplete Codex runtime: $source. No files were mixed with another build." }
  # Include every file shipped alongside the CLI, not only today's required set.
  if (@(Get-ChildItem -LiteralPath $source -Directory).Count) { throw 'Unsupported nested Codex runtime layout; refusing an incomplete snapshot.' }
  [string[]]$names = @(Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -ne 'runtime-manifest.json' } | ForEach-Object Name)
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $files = @($names | ForEach-Object { Get-Item -LiteralPath (Join-Path $source $_) })
  $manifest = @($files | ForEach-Object { [ordered]@{ name = $_.Name; size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
  $json = ConvertTo-Json -InputObject $manifest -Compress
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $id = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  $target = Join-Path $CacheRoot $id
  $mutex = New-Object Threading.Mutex($false, "Local\LarkCodexRuntime-$id")
  $held = $false
  try {
    try { $held = $mutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Runtime snapshot preparation is busy.' }
    if (-not (Test-Path -LiteralPath $target)) {
      New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
      $staging = Join-Path $CacheRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $staging | Out-Null
      # Failed staging is retained for diagnostics; never recursively delete a running runtime.
      foreach ($file in $files) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $staging $file.Name) }
      foreach ($file in $manifest) {
        if ((Get-FileHash -LiteralPath (Join-Path $staging $file.name)).Hash -ne $file.sha256) { throw 'Codex changed during copying; retry after the App update completes.' }
      }
      [IO.File]::WriteAllText((Join-Path $staging 'runtime-manifest.json'), $json)
      # Both absolute paths are below the explicit cache root; only rename this new staging directory.
      Move-Item -LiteralPath $staging -Destination $target
    }
    foreach ($file in $manifest) {
      if ((Get-FileHash -LiteralPath (Join-Path $target $file.name)).Hash -ne $file.sha256) { throw "Owned Codex runtime verification failed: $target. It was not overwritten." }
    }
    return Join-Path $target 'codex.exe'
  } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Resolve-WindowsCodexBinary {
  param([string]$Configured, [string]$LocalAppData = $env:LOCALAPPDATA)
  $managed = $Configured -match '[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]codex\.exe$'
  $snapshot = $Configured -match '[/\\]\.lark-channel[/\\]codex-runtime[/\\][a-f0-9]{64}[/\\]codex\.exe$'
  $bare = -not $Configured -or $Configured -match '^codex(\.exe|\.cmd|\.bat)?$'
  # Explicit custom binaries remain pinned, even when unavailable.
  if ($Configured -and -not $managed -and -not $snapshot -and -not $bare) {
    if (-not (Test-Path -LiteralPath $Configured -PathType Leaf)) { throw "Configured custom Codex executable is missing: $Configured" }
    return (Resolve-Path -LiteralPath $Configured).Path
  }
  $root = if ($managed) { Split-Path (Split-Path $Configured -Parent) -Parent } else { Join-Path $LocalAppData 'OpenAI\Codex\bin' }
  $roots = @($root, (Join-Path $LocalAppData 'OpenAI\Codex\bin')) | Select-Object -Unique
  foreach ($directory in $roots) {
    $candidates = @(Get-ChildItem -LiteralPath $directory -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '.staging-*' } | ForEach-Object {
      Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue
    } | Where-Object { -not $_.PSIsContainer -and $_.Length -gt 0 -and (Test-WindowsCodexRuntime $_.DirectoryName) } | Sort-Object LastWriteTimeUtc -Descending)
    if ($candidates.Count) { return $candidates[0].FullName }
  }
  # An in-progress App update must not take a verified owned runtime away.
  if ($snapshot -and (Test-WindowsCodexRuntime (Split-Path $Configured -Parent))) { return $Configured }
  $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-WindowsCodexRuntime (Split-Path $command.Source -Parent))) { return $command.Source }
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
