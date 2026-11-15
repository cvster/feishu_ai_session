# Fix only the existing node_repl MCP entry. Never restart Desktop or app-server.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$RepairUserPath)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only.' }
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
$source=Join-Path $PSScriptRoot 'windows-node-repl-host.cs'
$directory=Join-Path $env:USERPROFILE '.lark-channel\windows-launcher'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$hash=(Get-FileHash -LiteralPath $source).Hash.Substring(0,16).ToLowerInvariant()
$exe=Join-Path $directory "node-repl-host-$hash.exe"
if (-not(Test-Path -LiteralPath $exe)) { Add-Type -Path $source -OutputAssembly $exe -OutputType WindowsApplication -ReferencedAssemblies 'System.Web.Extensions.dll','System.Core.dll' }
$probe=New-Object Diagnostics.ProcessStartInfo
$probe.FileName=$exe;$probe.Arguments='--check';$probe.UseShellExecute=$false;$probe.CreateNoWindow=$true
$probe.RedirectStandardOutput=$true;$probe.RedirectStandardError=$true
$process=[Diagnostics.Process]::Start($probe)
$output=$process.StandardOutput.ReadToEndAsync();$errorOutput=$process.StandardError.ReadToEndAsync()
if(-not $process.WaitForExit(10000)){$process.Kill();throw 'Computer Use bootstrap probe timed out.'}
if($process.ExitCode -ne 0){throw $errorOutput.GetAwaiter().GetResult()}
if($CheckOnly){$output.GetAwaiter().GetResult();return}
$file=Join-Path $env:USERPROFILE '.codex\config.toml'
$text=[IO.File]::ReadAllText($file)
$pattern='(?ms)(^\[mcp_servers\.node_repl\]\r?\n)(.*?)(?=^\[|\z)'
$match=[regex]::Match($text,$pattern)
if(-not $match.Success){throw 'Existing node_repl MCP section not found; no config was changed.'}
$body=$match.Groups[2].Value
if([regex]::Matches($body,'(?m)^command\s*=').Count -ne 1){throw 'Ambiguous node_repl command; no config was changed.'}
$body=[regex]::Replace($body,'(?m)^command\s*=.*$',("command = '"+$exe+"'"))
$next=$text.Substring(0,$match.Index)+$match.Groups[1].Value+$body+$text.Substring($match.Index+$match.Length)
# Scope environment repairs to this MCP server, preserving all other entries.
$envMatch=[regex]::Match($next,'(?ms)(^\[mcp_servers\.node_repl\.env\]\r?\n)(.*?)(?=^\[|\z)')
if(-not $envMatch.Success){throw 'Existing node_repl environment section not found; no config was changed.'}
$envBody=[regex]::Replace($envMatch.Groups[2].Value,'(?m)^SKY_CUA_NATIVE_PIPE_DIRECTORY\s*=.*\r?\n','')
$worker=Get-Content (Join-Path $env:USERPROFILE '.lark-channel\profiles\codex\workers\codex\config.json') -Raw | ConvertFrom-Json
$cli=$worker.options.binaryPath
if(-not(Test-Path -LiteralPath $cli -PathType Leaf)){throw 'Protected CLI missing; no config was changed.'}
if($RepairUserPath){
  $oldPath=[Environment]::GetEnvironmentVariable('Path','User')
  $cliDirectory=Split-Path $cli -Parent
  $parts=@($oldPath -split ';' | Where-Object {$_ -and $_ -notmatch '[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]?$' -and $_ -ne $cliDirectory})
  $newPath=(@($cliDirectory)+$parts) -join ';'
  if($newPath -ne $oldPath){
    [IO.File]::WriteAllText((Join-Path $directory ('user-path-before-computer-use-'+(Get-Date -Format yyyyMMdd-HHmmss)+'.txt')),$oldPath)
    [Environment]::SetEnvironmentVariable('Path',$newPath,'User')
  }
}
$cliLine="CODEX_CLI_PATH = '"+$cli+"'"
if($envBody -match '(?m)^CODEX_CLI_PATH\s*='){$envBody=[regex]::Replace($envBody,'(?m)^CODEX_CLI_PATH\s*=.*$',$cliLine)}else{$envBody+=$cliLine+"`r`n"}
$next=$next.Substring(0,$envMatch.Index)+$envMatch.Groups[1].Value+$envBody+$next.Substring($envMatch.Index+$envMatch.Length)
if($next -ne $text){Copy-Item -LiteralPath $file -Destination ($file+'.before-dynamic-node-repl-'+(Get-Date -Format yyyyMMdd-HHmmss))
  $temporary=$file+'.dynamic.tmp';[IO.File]::WriteAllText($temporary,$next,[Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($temporary,$file,$file+'.dynamic-node-repl.previous')}
[pscustomobject]@{installed=$true;command=$exe;restarted=$false}|ConvertTo-Json -Compress
