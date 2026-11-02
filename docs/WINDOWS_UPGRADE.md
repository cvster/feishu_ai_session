# Windows Codex 升级与启动

本页和 `tools/windows-*.ps1` 仅适用于 Windows；不改变 Linux 的 CLI 查找、systemd、安装或部署流程。

首次部署、独立版本产物、桥接/worker 隐藏后台任务、Web、防火墙、验证和回滚，见
[Windows 完整部署文档](WINDOWS_DEPLOYMENT.md)。本页专门说明 Codex 升级与启动入口。
动手前先过一遍该页开头的 7 条硬约束；尤其不要重跑 `web configure`、不要按 node/codex 名字批量杀进程。

## 安装稳定启动入口

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows-install-launcher.ps1
```

安装器复制启动器到 `%USERPROFILE%\.lark-channel\windows-launcher`，备份已有脚本为
`.previous`，更新当前用户的登录任务，不启动或重启桌面、writer、worker、桥接。
后续更新启动脚本时再次执行即可。它不修改会话、队列、密钥或 Web 访问配置。

同一命令还会安装仓库内的蓝色 PNG/ICO、隐藏启动 PS1/VBS，创建“Codex 蓝色共享版”桌面
快捷方式。已有同名快捷方式先备份为 `.previous`；原 Codex 图标不变。需要仅安装脚本时
使用 `-NoShortcut`，不注册登录任务时使用 `-NoRegister`。`-Port` 会同步写入不含密钥的
`launcher.json`，快捷方式不含用户名、App 版本号、仓库目录或 release 路径。

Git 中包括完整启动资源；运行后生成的任务、快捷方式、日志、端点 token、个人模型配置和
真实 `web.json` 仍属于本机状态，不应提交。此安装器部署的是 Windows 启动入口，
不执行桥接构建/版本发布；`tools/deploy.mjs` 仍为 Linux systemd 部署程序。

桌面快捷方式应调用稳定目录下的 `windows-launch-desktop.ps1`，而不是版本化 App 路径或
某次部署的 release 目录。桌面 exe 每次通过 `Get-AppxPackage OpenAI.Codex` 查找。

## CLI 自动发现

- 对 Desktop 管理的 `OpenAI/Codex/bin/<版本>/codex.exe`，每次启动扫描版本目录，按文件
  修改时间选最新可用且非空的 exe，不要求旧目录先被删除。
- 对默认 `codex`，优先 Desktop CLI，再回退 PATH 中的 `codex.exe`。
- 自定义绝对路径保持固定；路径失效明确报错，不静默改用其它账号/安装。
- 启动新 writer 前检查 CLI 版本、`app-server --listen` 和 `queue --remote` 能力。
- 桥接底层已有 `resolveCodexBinary` / `spawnCodexProcess`，在每次创建 CLI 子进程时重新
  解析路径；无需为恢复已删除的 Desktop 版本路径而重启正在工作的 worker。此处不改变该跨平台代码。

## 安全启动与检查

```powershell
# 只读检查版本、路径、CLI 能力与 HTTP 就绪状态，不启动或重启任何服务
& "$env:USERPROFILE/.lark-channel/windows-launcher/windows-launch-desktop.ps1" -Check
# 常规打开桌面：先确保共享 writer 就绪，再带共享 URL 打开 App
& "$env:USERPROFILE/.lark-channel/windows-launcher/windows-launch-desktop.ps1"
```

共享 writer 已健康运行时继续复用；发现新版只返回 `updateAvailable`，**不会自动替换或
重启旧 writer**。新 exe 在 writer 下一次明确启动时使用。两个登录任务同时启动时由互斥锁
串行化 writer 创建。App 已运行但未接入共享端点时，提示用户手动关闭后重新打开，不强制杀进程。

## 升级后的边界

升级完成后使用专用快捷方式打开，检查 Desktop 与飞书的双向显示、问询和工具是否正常。
路径/CLI 参数检查不等于完整桌面协议兼容性检查。桌面的 `CODEX_APP_SERVER_WS_URL` 是
从当前实现确认的入口，不承诺未来版本不变；WebSocket 传输在官方文档中仍为实验性。
不修改 App 安装文件，不自动下载 Codex、不复制登录凭据，也不自动重启执行端。

[官方 app-server 协议](https://learn.chatgpt.com/docs/app-server#protocol)
