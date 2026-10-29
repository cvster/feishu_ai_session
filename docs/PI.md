# Pi Coding Agent 接入

Pi 使用独立 Worker，通过官方 JSONL RPC 执行。本项目验证基线为 `@earendil-works/pi-coding-agent` 1.4.0，命令名为 `pi`。旧包 `@mariozechner/pi-coding-agent` 已弃用。

## 安装与配置

安装实际使用的工具即可。安装脚本支持 `node tools/install.mjs --agents pi --install-clis`；已有桥接也可单独安装：

```sh
npm install -g @earendil-works/pi-coding-agent@1.4.0
```

在 Pi 中配置供应商和账号，默认目录为 `~/.pi/agent`。`models.json` 保存供应商地址、API 类型、模型和凭据，`settings.json` 保存默认模型。遵循 [Pi 模型配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。模型凭据必须保存在本机私有配置中。

已有 profile 使用 `~/.lark-channel/profiles/<profile>/workers/pi/config.json`：

```json
{
  "version": 1,
  "toolId": "pi",
  "options": {
    "binaryPath": "/absolute/path/to/pi",
    "agentDir": "/absolute/path/to/.pi/agent"
  }
}
```

`options.args` 可配置额外启动参数。配置文件权限设为 `600`。未指定路径时使用 PATH 中的 `pi` / `LARK_CHANNEL_PI_BIN`，配置目录使用 `PI_CODING_AGENT_DIR` 或上述默认目录。数据源身份为该配置目录的绝对路径。

需要明确复用当前 Zcode 账号时，执行一次：

```sh
node bin/lark-channel-bridge.mjs pi-import-zcode --profile <profile>
```

此命令从当前 Zcode Worker 的模型配置读取已启用供应商，按原供应商 ID 导入 Pi，映射 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages API，并复制当前默认模型。凭据和请求头作为字面值保存，避免触发 Pi 的命令或环境变量展开；输出只包含数量与路径。保留其他 Pi 供应商和设置，导入文件权限为 `600`。这是一次性导入；之后改 Zcode 配置，需要再次执行导入。自动发现、刷新模型和执行任务都不会再次复制凭据。

## 启动与使用

```sh
node bin/lark-channel-bridge.mjs worker start --tool pi --profile <profile>
node bin/lark-channel-bridge.mjs doctor --agents pi --profile <profile> --runtime
```

非 Linux 环境使用 `worker run --tool pi` 并由独立进程管理器托管。桥接重新发现 Worker 后，新建 AI 会话群、网页新建会话和辅助群关联列表会提供 **Pi**。已有其他工具的会话群继续使用原工具；为 Pi 创建新群或将辅助群关联到已有 Pi 会话。

支持新建和按精确 ID 续聊、流式文字、推理阶段与工具计数、停止本次任务、原生模型目录及各模型推理档位、图片输入、原生会话名称、JSONL 历史读取和原生 `clone` 复制。无历史的新群在首次提问后出现在 Pi 原生会话列表中。模型身份保留 `provider/model`，同名模型不合并；显式选择失效时拒绝执行，不切换供应商。刷新模型使用临时无持久会话的 Pi 进程，不发送提示词，不改原生会话、默认模型或配置。

## 边界

- Pi 不提供原生文件系统/进程权限沙箱。本适配器仅接受完整权限；只读或工作区权限请求在启动 Pi 前拒绝，不静默扩大权限。扩展的交互请求也不会自动回答。
- Pi 没有原生归档接口；桥接归档只关闭入口、保留原生历史，不宣称支持原生归档。控制台依赖原生归档的操作按能力隐藏。
- Pi JSONL 保存树状会话，只读取当前父链，避免重放废弃分支。Pi 未提供可靠的终端与 RPC 输入来源记录，未知来源按桥接输入处理：网页可读历史，但不将用户原生输入再次广播到飞书。
- Pi 终端与桥接共享原生文件。续聊或改名、复制前应让原终端停止使用该会话；桥接只管理自己的任务与 RPC 进程，不接管其他终端。停止只发送本进程的 `abort`。
- `agent_end` 后可能自动重试或压缩；桥接等待 `agent_settled` 才确认完成。连接中断或回执丢失时保留未确认状态，不重发提示词。

协议参考：[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[JSON 事件](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)。回归测试覆盖 RPC 协议与原生 CLI；`PI_NATIVE_BIN=/path/to/pi` 可启用只访问本机模拟供应商的原生测试，不使用真实账号或额度。
