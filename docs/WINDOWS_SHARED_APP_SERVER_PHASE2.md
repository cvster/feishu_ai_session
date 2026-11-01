# Windows 共享 app-server：第二阶段（桌面接入）结果与切换步骤

## 结论（2026-11-01）

第二阶段的核心问题已经解决：**在 Windows 上，可以让桌面 App 与飞书 Codex worker 使用同一个
本机 WebSocket app-server，且不需要修改 App 安装文件。**

实测（隔离实例，未触碰生产桌面）通过的关键项：

| 检查 | 结果 |
| --- | --- |
| 启动器托管的 `ws://127.0.0.1:4617` app-server 就绪（`/readyz` 200） | 通过 |
| 第二个桌面实例以 `CODEX_APP_SERVER_WS_URL` 连接该端点 | 通过，握手 `clientInfo.name = "Codex Desktop"` |
| 桌面进程树内是否另起 `codex.exe app-server` 子进程 | 0 个（未另起执行端） |
| worker 形态的 `CodexThreadReader` 读取该端点创建的会话 | 通过（`thread/read` 返回同一 threadId） |
| capability-token 保护端点：无 token 被 401 拒绝 | 通过 |
| worker reader 携带 bearer token 握手并只读调用 | 通过 |
| token 变量缺失时 fail closed | 通过 |

> 「worker 读取会话」使用 `thread/read`。新会话尚无轮次时 `thread/list` 不返回它，
> 且当前 build 的 `list_turns` 返回 `not supported yet`，所以完整历史投影未在此项内验收。

第一阶段留下的鉴权缺口（worker 无法携带 bearer token）已经补上，实现位置：
`packages/codex-core/src/thread-client.ts`（握手头）、`packages/codex-core/src/queue.ts`
（`--remote-auth-token-env`）、`src/agent/codex/*`、`src/session/codex-history.ts`、
`src/worker/*`、`src/config/profile-schema.ts`。

## 为什么必须自己起 app-server

本机桌面安装包（`26.1027.3384.0`，bundle `26.1027.30824`）的启动代码：

- 本地 daemon 自动接入分支明确要求 `process.platform !== 'win32'`，所以 Windows 桌面永远
  走 stdio，不会连 `~/.codex/app-server-control/app-server-control.sock`。
- 但它仍支持用 `CODEX_APP_SERVER_WS_URL`（或 hostConfig 的 `websocket_url`）连接外部
   WebSocket 端点。

因此 Windows 上"桌面提供共享端点"不可行，可行的是反向：**本机托管一个共享 app-server，
桌面连它**。

## ⚠ 这个端点不能开鉴权

桌面端为 WebSocket 握手注入 `Authorization` 的代码只对云端 host id（`ec.ZJQ(id)`）生效；
本机 host 的 `getWebsocketHandshake` 为 `undefined`。也就是说：

- 开启 `--ws-auth capability-token` 后，**桌面无法连接**（没有 token 注入入口）。
- 未鉴权的端点**只能**绑定回环地址。当前启动器固定 `ws://127.0.0.1:<port>`，
  不会监听 `0.0.0.0`，也不要把端口转发出去。

worker 侧的 bearer token 支持仍然保留并可测试，用于以后桌面版本支持本机握手鉴权、
或用于其它受保护的远端端点；它不影响当前的无鉴权回环方案。

## 启动器

Windows 升级友好的稳定入口安装、路径自动发现与只读检查，见
[Windows 升级说明](WINDOWS_UPGRADE.md)。新部署建议使用该入口，不把登录任务固定到某次 release。

新增 `tools/windows-shared-app-server.ps1`（托管服务端）与
`tools/windows-launch-desktop.ps1`（带 `CODEX_APP_SERVER_WS_URL` 启动桌面）：

```powershell
# 托管服务端（默认端口 4517，CODEX_HOME 默认 %USERPROFILE%\.codex）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action start
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action stop
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action install
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action uninstall

# 带共享端点启动桌面
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-launch-desktop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-launch-desktop.ps1 -Install
```

为什么要专用桌面启动器：`Start-Process` 和系统托盘/安装器启动的进程不会继承刚写入的用户
环境变量，只设 `[Environment]::SetEnvironmentVariable(...,'User')` 不足以让桌面连上共享端点；
必须在该进程的环境里显式设置。`-Install` 注册 `LarkChannelBridge.Desktop` 登录任务。

启动器只管理自己记录的进程；`stop` 会校验 PID 与命令行端点，不匹配则只清理状态文件，
不会误杀桌面或桥接。状态文件位于 `%USERPROFILE%\.lark-channel\shared-app-server\state.json`。

它会自动补齐桌面平时注入的两个环境变量：`CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY`
（取自 `Get-AppxPackage OpenAI.Codex`）与 `CODEX_MCP_NODE_PATH` 不需要手动设置；
以及 `CODEX_HOME`、`CODEX_SQLITE_HOME`。

## 当前部署状态（2026-11-01）

**生产切换已完成。** 本机三端现在共用同一个执行端：

| 组件 | 状态 |
| --- | --- |
| 共享 app-server | `ws://127.0.0.1:4517`（`CODEX_HOME=%USERPROFILE%\.codex`），登录自启任务 `LarkChannelBridge.SharedAppServer` |
| Codex 桌面 | 已接入 4517；桌面进程树内无自起 app-server |
| Codex worker | `releases/55e5db7`，`appServerRemote = ws://127.0.0.1:4517`，健康 |
| 桥接 | `releases/55e5db7`，飞书 WebSocket 已连接 |
| 桌面启动 | 登录自启任务 `LarkChannelBridge.Desktop`（`tools/windows-launch-desktop.ps1`） |

验收结果（生产环境，真实模型）：

- worker `/sessions` 从 `socket hang up` 变为返回完整会话列表。
- 桥接发起的轮次写入共享端点，worker 读到该轮次且 `bridge = true`。
- 原生客户端在共享端点发起的轮次，worker 读到 `bridge = false`、`terminal = done`。
- 共享端点 `status` 中 `desktopConnections` 出现 `ChatGPT.exe`。

一次性修复：`55e5db7` 修正了 adapter 把所有 `ws://` 端点都当成必须带 token 的问题；
无 token 配置的回环端点现在可以直接连接。

## 生产切换步骤（已完成，保留备查）

以下操作会中断桌面当前正在运行的任务，应在用户确认后的维护窗口执行。**不要**在常规桥接
部署中顺带做。

1. **先备份桌面启动方式。** 记录当前登录账户、`CODEX_HOME`（默认 `%USERPROFILE%\.codex`）
   与桌面版本。桌面的回滚就是"不带 `CODEX_APP_SERVER_WS_URL` 直接启动"。
2. **启动共享服务并确认就绪：**

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action start -Port 4517
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action status
   ```

   记录输出中的 `pid` / `url` / `codex` / `codexHome`。
3. **让 worker 指向该端点。** 编辑
   `%USERPROFILE%\.lark-channel\profiles\codex\workers\codex\config.json`：

   ```json
   {
     "version": 1,
     "toolId": "codex",
     "options": {
       "binaryPath": "C:\\...\\codex.exe",
       "inheritCodexHome": true,
       "ignoreUserConfig": false,
       "ignoreRules": true,
       "appServerRemote": "ws://127.0.0.1:4517"
     }
   }
   ```

   不要设置 `appServerRemoteTokenEnv`：该端点无鉴权，设置后握手会带不会被校验的头，
   且当前桌面方案不依赖它。
4. **重启 Codex worker**（会中断 worker 正在执行的飞书任务）：

   ```powershell
   node bin\lark-channel-bridge.mjs worker stop --profile codex --tool codex
   node bin\lark-channel-bridge.mjs worker start --profile codex --tool codex
   node bin\lark-channel-bridge.mjs worker status --profile codex --tool codex
   ```

5. **重启桌面并让它连共享端点。** 关闭桌面后，用带环境变量的方式启动
   （`CODEX_APP_SERVER_WS_URL` 只对该进程及其子进程生效）：

   ```powershell
   $env:CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:4517'
   & "$env:LOCALAPPDATA\Microsoft\WindowsApps\ChatGPT.exe"
   ```

   或直接使用 `tools\windows-launch-desktop.ps1 -Install`，它注册的登录任务会带好该变量。
6. **验收（缺一不可）：**

   - `-Action status` 的 `desktopConnections` 中出现 `ChatGPT.exe`。
   - 桌面会话里发一条消息 → 飞书侧看到同一轮次与回复。
   - 飞书发一条 → 桌面实时出现。
   - 停止、问询选项、模型/推理档位、归档与改名各做一次。
   - 检查桌面自带工具/MCP 是否仍可用。

7. **回滚：** 关闭桌面，清除 `CODEX_APP_SERVER_WS_URL` 后正常启动桌面；
   从 worker 配置删除 `appServerRemote` 并重启 worker；最后 `-Action stop` 停止共享服务。
   全程不要删除会话历史、SQLite 或队列账本。

## 已知限制

- 共享端点无鉴权，只能回环使用。
- WebSocket 传输在官方文档中仍标为实验性。
- 历史投影对空会话不可用（见上文 `list_turns`）；有轮次的会话在隔离测试中正常。
- 桌面连接的是"本机托管的一次性进程"，其可用性依赖启动器；已提供 `-Action install`
  的计划任务托管，但退出登录期间不会运行。
- 隔离测试使用未登录的独立 `CODEX_HOME` 与本地模型模拟；真实登录、模型推理、桌面工具注入
  仍要在生产切换的验收步骤中确认。

## 复跑

```powershell
# 鉴权链路（真实 codex.exe，capability-token，隔离 home）
$env:BRIDGE_CODEX_WS_PHASE2 = '1'
$env:BRIDGE_CODEX_WS_PHASE2_BIN = '<codex.exe 绝对路径>'
pnpm exec vitest run tests/integration/worker/codex-ws-phase2-auth.live.test.ts --reporter=verbose

# 桌面 + worker 共用同一端点（需先启动启动器）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows-shared-app-server.ps1 -Action start -Port 4617 -CodexHome '<隔离 CODEX_HOME>'
$env:BRIDGE_CODEX_SHARED_URL = 'ws://127.0.0.1:4617'
$env:BRIDGE_CODEX_SHARED_HOME = '<隔离 CODEX_HOME>'
$env:BRIDGE_CODEX_SHARED_DESKTOP = '1'
pnpm exec vitest run tests/integration/worker/codex-shared-desktop.live.test.ts --reporter=verbose
```

两个测试默认跳过，不会随常规 `pnpm test` 启动真实桌面或 app-server。
