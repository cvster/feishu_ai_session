# Windows 完整部署、升级与回滚

适用于本仓库的 Windows 本机部署。Linux 继续使用 [INSTALL 第 9 节](INSTALL.md#9-生产产物部署与升级)
中的 `tools/deploy.mjs`；不要在 Windows 运行该 systemd 脚本。本页使用 PowerShell，
示例 profile 为 `codex`（当前桌面共享启动器也读取此 profile）。不涉及 SSH 或远程 pc/px。

## 1. 前置条件和目录

- 以日常使用 Codex 的同一个 Windows 用户安装、登录和注册任务；不要换成 SYSTEM。
- 安装 Git、Node.js/npm（满足 package.json 要求）、Codex Desktop；让 Node 和 Git 在 PATH 中可用。
- 源码、版本产物和配置分开保存。示例：

```powershell
$Repo = 'C:\software\lark-coding-agent-bridge'
$Runtime = 'C:\software\feishu-ai-session-runtime'
$HomeDir = Join-Path $env:USERPROFILE '.lark-channel'
$Profile = 'codex'
$Node = (Get-Command node.exe -CommandType Application).Source
Set-Location -LiteralPath $Repo
```

配置与会话状态在 `$HomeDir`，Codex 登录与历史通常在 `~/.codex`，不复制进 release 或 Git。
示例路径可调整，但后续任务必须使用真实绝对路径。不要使用 npx 缓存或临时目录运行长期服务。

## 2. 首次安装与配置

```powershell
git clone https://github.com/cvster/feishu_ai_session.git C:\software\lark-coding-agent-bridge
Set-Location C:\software\lark-coding-agent-bridge
node tools/install.mjs --agents codex --install-clis
```

仓库已存在时不要重复 clone。安装器准备固定版本 pnpm、依赖和构建；Windows 不使用
`--configure --start` 自动启动 worker。首次按 [INSTALL 第 3—7 节](INSTALL.md) 完成
工具登录、profile、`setup`、飞书权限、事件、卡片回调、应用发布和可用范围。
真实密钥使用交互/本地密钥存储，不填到本文命令、任务参数或提交中。

```powershell
# 仅新 profile 执行；已配置的机器跳过，不覆盖其配置
node bin/lark-channel-bridge.mjs profile create codex --agent codex --workspace 'C:\projects'
node bin/lark-channel-bridge.mjs setup --profile codex
```

确保 workspace 已存在，且当前用户可访问。安装器的 pnpm 默认位于：

```powershell
$Pnpm = Join-Path $env:USERPROFILE '.local\share\codexfeishu-tools\node_modules\pnpm\bin\pnpm.cjs'
```

若设置过 `CODEXFEISHU_TOOLS_DIR`，按该目录调整 `$Pnpm`。以后通过 `& $Node $Pnpm ...`
调用，不依赖全局 pnpm。首次安装和升级都应保留各项失败信息，不能把构建成功当作真实收发成功。

## 3. 生成独立版本产物

更新已有仓库前先确认工作区干净；存在个人修改时停止，不自动 reset/stash 或解决冲突。

```powershell
if (git status --porcelain) { throw 'Working tree is not clean' }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Git update failed' }
& $Node $Pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& $Node $Pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
# 按改动运行相关测试；完整测试可用 test，不隐瞒平台相关失败
& $Node $Pnpm exec vitest run tests/unit/cli/windows-launcher.test.ts tests/unit/agent/codex-binary.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& $Node $Pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

$Sha = (git rev-parse --short=12 HEAD).Trim()
$Release = Join-Path $Runtime "releases\$Sha"
if (Test-Path -LiteralPath $Release) { throw 'Release already exists; verify it, do not overwrite it' }
New-Item -ItemType Directory -Path $Release -Force | Out-Null
$Archive = Join-Path $Release 'source.tar'
git archive --format=tar --output $Archive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Git archive failed' }
tar -xf $Archive -C $Release
if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed' }
Remove-Item -LiteralPath $Archive
$Outputs = @('dist', 'packages/codex-core/dist',
  'apps/web-app/upstream-overrides/claudecodeui-1.25.2/server/codex-core',
  'apps/web-app/upstream-overrides/claudecodeui-1.25.2/shared/codex-core-models.js')
foreach ($Output in $Outputs) {
  $Target = Join-Path $Release $Output
  New-Item -ItemType Directory -Path (Split-Path $Target -Parent) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Repo $Output) -Destination $Target -Recurse -Force
}
Push-Location -LiteralPath $Release
try {
  & $Node $Pnpm install --prod --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
} finally { Pop-Location }
git rev-parse HEAD | Set-Content -LiteralPath (Join-Path $Release 'DEPLOYED_COMMIT')
& $Node (Join-Path $Release 'bin/lark-channel-bridge.mjs') --help
if ($LASTEXITCODE -ne 0) { throw 'Release entrypoint failed' }
```

仅从同一提交的构建产物发布，不能混用源码目录的旧 dist。每个 release 保留独立依赖；
失败留下的目录视为不完整，不直接复用。运行中的 worker 仍可能加载旧目录，不删除旧版本。

## 4. Codex 桌面共享执行端

```powershell
& (Join-Path $Repo 'tools/windows-install-launcher.ps1')
& "$env:USERPROFILE/.lark-channel/windows-launcher/windows-launch-desktop.ps1" -Check
```

安装器部署稳定脚本、蓝色图标、隐藏快捷方式和登录任务，**不会启动或重启任何进程**。
首次点击“Codex 蓝色共享版”会先确保 `ws://127.0.0.1:4517` 就绪，再打开桌面。
若原桌面未连接该执行端，先由用户手动退出，再点蓝色入口；常规桥接升级不顺带重启桌面。
新旧 CLI 路径自动发现及兼容边界见 [WINDOWS_UPGRADE](WINDOWS_UPGRADE.md)。

首次为 `%USERPROFILE%\.lark-channel\profiles\codex\workers\codex\config.json` 配置：

```json
{
  "version": 1,
  "toolId": "codex",
  "options": {
    "inheritCodexHome": true,
    "ignoreUserConfig": false,
    "ignoreRules": true,
    "appServerRemote": "ws://127.0.0.1:4517"
  }
}
```

不要覆盖已有 worker 的其他选项。`binaryPath` 可用本机 Desktop CLI 路径，底层 spawn 会
重新发现新版；自定义执行器按原设置保留。共享端点仅回环，无须设置 token 环境变量；
绝不能把未鉴权的执行端开放到局域网。Web 的对外端口与此执行端完全不同。

## 5. 前台验收和隐藏后台任务

先在独立终端运行 worker，验证后仅在首次切换后台时退出这个前台 worker：

```powershell
$Entry = Join-Path $Release 'bin/lark-channel-bridge.mjs'
& $Node $Entry worker run --profile codex --tool codex --config (Join-Path $HomeDir 'config.json')
```

另开终端运行 `doctor --profile codex --agents codex --runtime --network`，然后 `run --profile codex`
前台核验飞书收发。确认桌面和飞书使用同一会话、互相可见，且按钮、问询、附件正常。
已有生产 worker 不要为此重复启动；不能用 `/health` 代替共享会话验收。

Windows worker 用 `worker run` 自行托管；Linux 的 `worker start` 不能照搬。
建议在“任务计划程序”分别注册两个任务，或用 PowerShell `Register-ScheduledTask`：

| 项 | 桥接任务 | Codex worker 任务 |
|---|---|---|
| 名称 | `LarkChannelBridge.Bot.codex` | `LarkChannelBridge.Worker.codex.codex` |
| 用户 | 当前完整身份（如 `DOMAIN\user`），仅登录时运行，普通权限 | 相同 |
| 触发器 | 当前用户登录 | 相同 |
| 程序 | `powershell.exe` | 相同 |
| 参数 | `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <下述编码>` | 相同 |
| 工作目录 | 对应独立 release | 对应独立 release |
| 设置 | 无执行时限；允许电池；失败 1 分钟后重试；不启动并行实例 | 相同 |

生成动作的编码内容（只输出配置代码的编码，不包含密钥）：

```powershell
function Quote-PS([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$Logs = Join-Path $HomeDir 'profiles/codex/logs/windows'
New-Item -ItemType Directory -Path $Logs -Force | Out-Null
# 桥接用 run；仅首次安装 worker 或明确升级 worker 时改为 worker run --tool codex
$Mode = 'run'
$Script = @(
  '$ErrorActionPreference = "Stop"',
  ('Set-Location -LiteralPath ' + (Quote-PS $Release)),
  ('$env:LARK_CHANNEL_HOME = ' + (Quote-PS $HomeDir)),
  ('$env:PATH = ' + (Quote-PS $env:PATH)),
  # Windows PowerShell 5 的原生命令 stderr 不应被误当作终止异常
  '$ErrorActionPreference = "Continue"',
  ('& ' + (Quote-PS $Node) + ' ' + (Quote-PS $Entry) + ' ' + $Mode +
    ' --profile codex --config ' + (Quote-PS (Join-Path $HomeDir 'config.json')) +
    ' >> ' + (Quote-PS (Join-Path $Logs 'stdout.log')) +
    ' 2>> ' + (Quote-PS (Join-Path $Logs 'stderr.log'))),
  'if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE'
) -join "`n"
[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
```

桥接/worker 应使用各自日志文件名。不要把 API key 填进动作或将编码当作加密存储。
隐藏选项在 PowerShell 动作中设置；已有 `.cmd` + VBS 隐藏任务可继续使用，无需为文档统一
而替换运行中的 worker。不要同时保留两个指向同一 profile 的桥接启动任务。

当前实例可能由旧 `.cmd` 启动；先导出任务 XML、备份它的动作和启动脚本，再修改。
本仓库 CLI `start` 也支持 Windows 桥接任务，但其默认 `.cmd` 启动可能出现黑框，
本页的隐藏任务是替代托管方案，不应与它重复注册运行。

## 6. Web 与防火墙

首次 Web 配置可执行 `web configure --profile codex --host 127.0.0.1 --port 36666`。
已有配置不重复 configure（会更换 Token）；保留 `secretHash`、`passwordHash` 及其余字段，
按 [Web 文档](BRIDGE_WEB_PLAN.md) 修改 `host`、`additionalHosts`、`port`、`trustedNetworks`。
选择本机实际存在的地址，不照抄其他机器的 IP。重启桥接后生效，worker 不重启。

例如同时监听回环与某个 `192.168.188.*` 本机地址，并信任 `192.168.188.0/24`，意味着该网段
能够直接以所有者身份操作 Web，会话和控制功能不再要求密码。不要配置所有来源免密。
使用真实 TCP 来源判定，不信任代理转发头；保留 Host/Origin 校验。

局域网/VPN 访问还需管理员检查 Windows 防火墙：入站 TCP 端口、精确本机地址、来源网段、
网卡和网络类别均应匹配。已有 Node **阻止**规则会优先于新增允许规则；不能只添加 allow 就
假报成功。不要全局关闭防火墙或放开所有 Node 端口。本机访问成功不证明其他设备已可访问。

## 7. 常规升级：只切换桥接

1. 按第 3 节生成新 release。保存旧 release 路径、桥接任务 XML/动作、启动脚本，及构建提交。
2. 按第 4 节更新稳定入口资源即可；安装器不重启进程。不再运行 profile create、setup、web configure。
3. 仅结束桥接任务；`Stop-ScheduledTask` 可能留下 Node 子进程，不能只看任务状态。
   用 `Get-CimInstance Win32_Process` 根据**旧 entry 的绝对路径 + 精确的 `run --profile codex`**
   识别桥接 Node，校验后只 `Stop-Process -Id <桥接PID>`，等待退出。不要按 node/codex 名称批量杀进程，
   不要匹配成 `worker run`，不杀桌面、共享 writer 或 worker。
4. profile 的 proper-lockfile 可能仍存在于
   `~/.lark-channel/registry/locks/profile/codex.lock.lock`。等待它消失或最后更新时间超过
   31 秒（正常更新间隔约 10 秒、stale 30 秒），最多等 40 秒；失败则诊断，不强删锁或队列。
5. 把桥接动作/已有隐藏 launcher 中的工作目录和 entry 改为新 release，再启动同一个桥接任务。
   不改 worker 正在使用的 release。需要 worker 新功能时另行明确安排对应 worker 更新。
6. 记录实际新 Node PID、release、提交、关键产物 SHA-256、检查结果和旧版本回滚入口。

以上服务进程/文件核验不是检查模型任务是否在跑，不作为额外重启确认门槛。
日常桥接升级不停止已接收任务，也不删除收件箱、会话、收据或投递账本。

## 8. 上线验证

- `Get-ScheduledTask` 的桥接/worker 任务正常；还需核对实际 Node PID 和动作中的绝对路径。
- 共享执行端 `http://127.0.0.1:4517/readyz` 返回 200，桌面和 worker 仍连接同一 writer。
- `http://127.0.0.1:36666/`、`/console` 和 `/api/access` 返回预期结果；免密入口的
  `loginRequired` 为 false，`/api/console` 显示桥接连接状态。检查新地址/端口全部监听成功。
- worker 的 endpoint.json 仅在内存读取 token，带 Authorization 请求 `/health`、`/sessions`；
  不在终端或报告打印 token。一次 `/health` 200 不证明会话列表、模型或真实推理正常。
- 在专用测试群做真实双向聊天、排队、按钮、问询与附件验收；不要重放旧生产输入。
- 检查 JSON 日志中的飞书连接、投递和同步错误；不要因为网页可打开便忽略卡片更新失败。
- Windows 只在用户登录期间运行此套 Interactive 任务。共享启动任务不是持续的崩溃守护器，
  它退出后 writer 崩溃不会自动触发任务的失败重试；应明确记录此限制。

## 9. 回滚与故障恢复

- **仅桥接代码故障**：按第 7 节只停止新桥接，将任务动作/隐藏 launcher 恢复为已备份的旧
  release，启动并重复第 8 节验证。旧 release 的 dist 和依赖必须还在。
- **启动器资源故障**：稳定目录中的 `.previous` 和快捷方式备份用于恢复单个文件；PS1/VBS/
  图标要恢复同一套版本。也可从已验证旧提交检出到另一个目录后重新运行安装器，不覆盖当前源码修改。
- **Codex 升级不兼容**：`-Check` 查看发现的 exe 和能力。健康的旧 writer 不自动重启；
  需要切换 writer/桌面时另行维护，不把它夹在桥接回滚里。
- **恢复桌面默认启动方式**：这是单独的维护操作。先手动关闭桌面，禁用共享桌面登录任务，
  清除用户级和当前进程的 `CODEX_APP_SERVER_WS_URL`，再从正常入口启动；worker 必须另行
  调整连接方式。不要在 worker 仍依赖共享端点时直接关 writer。
- 不用旧的整份 `.lark-channel`/`.codex` 备份覆盖当前状态；那会回退队列/收据/历史。
  运行配置只按必要字段恢复。日志和脱敏部署记录可本地保留，不提交真实凭据或个人会话。

本页为完整**手动 Windows 部署操作规程**，不是声称已有 Windows 一键版本部署程序。
当前一键脚本仅安装共享启动入口；Linux 的自动发布/回滚逻辑不受本文影响。
