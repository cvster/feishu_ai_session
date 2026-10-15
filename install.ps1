# Windows: powershell -File .\install.ps1 --agents codex
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '需要先安装 Node.js >=20.12（推荐 Node 24，含 npm）：https://nodejs.org/en/download'
}
Push-Location $PSScriptRoot
try {
  & node tools/install.mjs @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
