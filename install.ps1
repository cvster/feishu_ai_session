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

Write-Host ''
Write-Host '依赖与构建已就绪，但这不等于部署完成。下一步：'
Write-Host '  1. 以日常使用 Codex 的同一个 Windows 用户登录所选工具。'
Write-Host '  2. 按 docs/WINDOWS_DEPLOYMENT.md 第 2—3 节创建 profile，并生成独立版本产物'
Write-Host '     （runtime\releases\<sha>，不要直接运行 tools/deploy.mjs）。'
Write-Host '  3. 按第 4 节安装桌面共享启动入口（蓝色快捷方式 + 登录任务）：'
Write-Host '     tools\windows-install-launcher.ps1，并把 worker 的 config.json 指向'
Write-Host '     ws://127.0.0.1:4517（仅回环，不要开放到局域网）。'
Write-Host '  4. 按第 5 节以前台 worker 验收后再注册计划任务；第 8 节为上线验证。'
Write-Host '蓝色图标是本地非官方快捷方式资源，不替代已安装 App 的资源，也不改动其文件。'
