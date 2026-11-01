# Windows 共享 app-server：第一阶段验证与第二阶段交接

## 结论（2026-11-01）

使用当前安装的 `codex-cli 0.166.0-alpha.5.1`，真实 app-server、真实 Codex
worker 和本机确定性模型模拟服务完成第一阶段验证。14 项检查通过，测试进程全部关闭。
这是传输/worker 集成验证，不是桌面接入或真实模型推理验收。

生产桥接、生产 worker、当前桌面 App、当前会话及远程 pc/px 均未修改或重启。
本次只增加测试和交接文档，不部署生产服务。

## 隔离边界

- 每次生成全新临时 `CODEX_HOME`、SQLite 目录、工作目录、worker 状态目录和随机本机端口。
- 不复制登录凭据；清除测试子进程继承的 API key/access-token 环境变量。
- `account/read` 确认测试账户未登录。模型请求只发给本机 SSE 模拟服务，不消耗真实模型 token。
- 测试会话名称不以 AA 开头；不启动飞书连接，不向真实群发送消息。
- app-server 只监听 `127.0.0.1`。无鉴权与有 capability-token 鉴权的测试分别使用不同端口。
- `finally` 关闭测试 worker、WebSocket、模型服务及 app-server；断言测试 app-server 子进程已经退出。
- 保留临时日志和 JSON 报告以便核对。临时传输 token 对已关闭的测试进程不再有效；报告不包含 token。

## 已验证的 14 项

1. 本机回环 HTTP 就绪检查。
2. 公开 WebSocket JSON-RPC 初始化握手。
3. 独立账户未登录，未复用生产凭据。
4. 在独立目录创建测试会话。
5. 原生客户端发消息并得到预设回复。
6. worker 通过同一 WebSocket 读取会话及历史。
7. worker 提交消息并得到回复；原生客户端同时收到该回复的完成事件。
   同时校验原生消息保持原生来源，worker 消息识别为桥接来源。
8. 运行中添加原生队列消息，worker 停止当前轮次，队列消息保留；不由测试手动启动队列，
   等待 worker 默认 15 秒维护轮询自动启动队列首条，确认完成且恢复凭据已持久化。
9. worker 发现另一客户端发起的原生问询，并成功回传选项答案。
10. 原生问询的完整工具调用/回答/最终回复闭环。
11. 开启 capability-token 的 app-server 就绪检查。
12. 缺少传输 token 的客户端被拒绝（HTTP 401，而不是将连接失败误算为鉴权通过）。
13. 携带 bearer token 的测试客户端握手及只读调用成功。
14. **预期限制检查**：当前 stock worker reader 没有 bearer-token 配置，连接受保护的
    WebSocket 被 401 拒绝。此项“通过”表示限制被成功复现，并不表示 worker 支持鉴权。

## 复跑

在仓库根目录用 PowerShell 执行，明确指定当前安装的 Codex CLI：

```powershell
$env:BRIDGE_CODEX_WS_PHASE1 = '1'
$env:BRIDGE_CODEX_WS_PHASE1_BIN = '<当前 codex.exe 的绝对路径>'
$env:BRIDGE_CODEX_WS_PHASE1_REPORT = "$env:TEMP/codex-ws-phase1-report.json"
pnpm exec vitest run tests/integration/worker/codex-ws-phase1.live.test.ts --reporter=verbose
```

测试默认跳过，不会随常规 `pnpm test` 启动真实 app-server。
测试返回成功要求所有检查通过且 app-server 子进程已经退出。任何失败查看报告及其
`root` 目录中的 `app-server.log`、`authenticated-app-server.log`，不要仅凭 worker `/health` 判断执行端正常。

## 交给 Zcode 的第二阶段

目标：验证**不修改 App 安装文件**，仅调整启动连接方式，能否让桌面与 worker 使用同一个
本机共享 app-server。第一阶段没有切换生产桌面；以下是待执行和待验证内容，不是已实现承诺。

### 已有证据

- 本机桌面安装包版本为 `26.1027.3384.0`，其 bundle package version 为 `26.1027.30824`。
- 安装包启动代码的本地 daemon 自动接入分支显式要求 `process.platform !== 'win32'`。
  因此仅设置 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 不能令此 Windows 版本进入该分支。
- 同一安装包存在 `CODEX_APP_SERVER_WS_URL` / `hostConfig.websocket_url` 的外部 WebSocket
  路由。此环境变量是在安装代码中发现的入口，未找到官方稳定文档保证；应当先隔离验证。
- 当前桌面运行的是 stdio app-server，没有共享 TCP listener 或默认 control socket。
  不应把新 worker 的 socket 连接错误解释成飞书断连。

### 第二阶段检查清单

1. 先确认能否用独立用户数据/配置启动真正隔离的第二个桌面实例，避免 Electron 单实例
   转发使环境变量实际未生效。若无法隔离，不要把第一阶段测试成功当作桌面测试成功。
2. 需要切换生产桌面时，由 Zcode 在 App 外执行；保存原启动配置、连接参数和回滚方式，
   明确桌面重启会中断其当前任务。本聊天中的 agent 不应承担重启后的唯一控制/回滚职责。
3. 让桌面与测试 worker 指向同一个本机 WebSocket 实例。确认桌面没有另起一个承载同一
   测试会话的 stdio writer。仅共用 CODEX_HOME/历史目录并不能证明共用了执行端。
4. 不要将第一阶段的未登录 mock-model 配置误用作生产配置。真实登录、模型目录及推理需另验。
   不要盲目复制、打印或提交账户凭据。
5. 真实验收：桌面发消息→worker 看到完整结果；worker 发消息→桌面实时显示；双端排队；
   停止当前消息后后续继续；问询选项及答案；模型/推理程度；归档和名称同步。
6. 单独检查桌面内置工具/MCP 配置注入、审批和登录刷新。外接 app-server 绕过了默认
   stdio 启动流程，不能只用一条文字回复判断桌面功能完整。
7. **鉴权缺口**：现有 worker reader 不能给 WebSocket 握手加 bearer token；桌面外部
   WebSocket 路由的鉴权配置也尚未验证。不要把未鉴权执行端开放到非回环地址，不把
   token 填进 URL/日志，不将“本机隔离无鉴权测试通过”视为生产安全配置已完成。
8. 记录失败项；失败时恢复桌面原启动方式，勿修改当前会话历史/数据库、强抢 writer、
   重发生产输入或启停远程机器。生产桥接切换应与桌面验收区分。

官方说明：

- [App-server 传输与鉴权](https://learn.chatgpt.com/docs/app-server#protocol)
- [初始化协议](https://learn.chatgpt.com/docs/app-server#initialization)

WebSocket 传输仍标为实验性、不支持生产用途；本次实测可行性不等于官方兼容性保证。
