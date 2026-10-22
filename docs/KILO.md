# Kilo 接入

Kilo 支持 VS Code 插件和独立 CLI，通过统一 worker 接入飞书。Kilo App/Desktop
已移除：不会发现 App 后端，也不会列出或续聊带 `kilo-desktop` 标记的旧 App 会话；
原生历史保留。可以只部署 Kilo，无需安装 Codex 或其他工具。

## 本机准备

先安装并登录官方 VS Code 扩展或 CLI。执行设置位于
`profiles/<profile>/workers/kilo/config.json`：

```json
{
  "version": 1,
  "toolId": "kilo",
  "options": { "binaryPath": "kilo", "editorSync": true }
}
```

可配置 `dataHome`、`args` 等执行选项。来源目录默认是 `$XDG_DATA_HOME/kilo` 或
`~/.local/share/kilo`。不要直接更换已有群的数据源。旧根 `profiles.<profile>.kilo`
设置首次导入此文件，旧 `preferredClient` 丢弃，之后以 worker 配置为准。

Linux 默认启用 `editorSync`，连接同一 OS 用户、同一数据库且项目目录最匹配的
VS Code 后端。多个同等候选会拒绝提交，已选后端断开后不会换后端重发。认证只在
内存使用；不会写入配置或日志。没有匹配窗口、不支持 `/proc`、使用自定义启动参数
时使用独立 CLI 后端。`editorSync: false` 始终使用独立后端。

## 启动和使用

```bash
lark-channel-bridge worker start --profile my-bot --tool kilo
lark-channel-bridge worker status --profile my-bot --tool kilo
lark-channel-bridge run --profile my-bot
```

Linux 服务名为 `lark-channel-worker.kilo.my-bot.service`。其他系统使用
`worker run --profile my-bot --tool kilo` 自行托管。桥接自动发现该 worker；安装其他
工具时无需修改桥接的工具配置。升级执行适配器需单独更新 Kilo worker。

私聊机器人「新建会话」选择 Kilo，填写工作群名及项目目录。正式标题以 AA 开头的
原生会话可自动建群。个人群与原生会话一对一绑定；会话共享及 AI助手入口继续续聊
所选原会话，各群只接收自己的请求回复。工具/来源不会自动切换。

## 同步、模型和执行

- VS Code 中的输入和回答通过 worker 会话快照同步到个人群；飞书任务由 worker
  收据回复，来源标记防止重复转发。共享群不广播原生界面消息。
- 首次绑定建立历史基线；桥接重启继续更新原卡片。状态在
  `kilo-native-turn-sync.json`，旧 `kilo-turn-sync.json` 自动导入。
- 群名与原生标题双向同步，初次及同时修改以群名为准。仅处理唯一绑定的活跃个人群，
  使用 worker list/rename 接口，不调用模型。状态在 `kilo-name-sync.json`。
- `/config` 动态读取供应商、完整模型 ID 和该模型的原生 variants；已选模型失效时
  提示重新选择，不切换供应商。普通输入原样提交；附件以本机文件路径提供。
- 流式文本、思考、工具结果按原生会话及本次用户消息过滤。停止针对本次任务或当前
  镜像轮次，旧卡片不会停止新轮次。复制会话调用原生 fork，归档保留历史。
- 原生权限和交互弹窗未转接飞书，不自动同意；受限操作的所有者确认卡继续沿用
  会话共享业务逻辑。权限约束不是操作系统沙箱。
- 共享 VS Code 后端的工具、MCP 和 CLI 环境由 VS Code 管理；独立 worker 环境需要
  `editorSync: false`。连接关闭不终止编辑器。原生界面与飞书并发写同一会话仍需避免。
- 桥接重启脱离观察，worker 继续任务；worker/主机重启不保证保活，未知收据不重跑。

[统一接口](WORKER_API.md) · [迁移步骤](WORKER_MIGRATION.md) ·
[官方扩展架构](https://kilo.ai/docs/contributing/architecture/vscode-extension) ·
[CLI 架构](https://kilo.ai/docs/contributing/architecture/cli-runtime)

可选真实验证会创建并归档临时会话，使用本机已有账号：

```bash
KILO_LIVE_SMOKE=1 pnpm exec vitest run tests/integration/kilo/live.test.ts
```
