# ZCode 接入与工具扩展

同一飞书应用可同时连接 Codex、Claude Code 和 ZCode。工作群创建时选择工具；绑定后保持工具、数据源和原生会话 ID，不会在某工具不可用时切换引擎。FF 辅助群、私聊群及 A2A 共用已有执行入口和权限确认流程，不需要额外申请飞书权限。

## 安装和配置

先安装并配置 [官方 ZCode](https://github.com/zai-org/ZCode)。本次验证环境为 Linux、ZCode Agent CLI **0.16.5**。安装脚本的 `--install-clis` 仍只安装 Codex/Claude，ZCode 需单独准备。

`/usr/bin/zcode` 可能是桌面启动器，不能作为 Agent CLI。桥接在常见安装路径找到桌面附带的 `resources/glm/zcode.cjs` 后，使用 Node 运行它；也可以在 profile 中显式配置：

```json
{
  "zcode": {
    "binaryPath": "/absolute/path/to/node",
    "args": ["/opt/ZCode/resources/glm/zcode.cjs"]
  }
}
```

以上字段合入现有 profile，保留其他配置。已有 Codex/Claude profile 无须修改 `agentKind`；它只决定默认工具。新 profile 可使用 `profile create --agent zcode`。

模型列表和账号配置动态读取，默认优先使用桌面当前的 `~/.zcode/v2/provider_config.json`；无需把供应商和密钥复制到独立 CLI。可通过 `zcode.modelConfigPath` 显式指定配置来源。完整来源优先级、刷新和失效处理见 [动态模型列表](MODELS.md)。独立 CLI 的 `~/.zcode/cli/config.json` 仍受支持，权限设为 `600`，示意：

```json
{
  "model": { "main": "my-provider/my-model" },
  "provider": {
    "my-provider": {
      "kind": "openai",
      "options": { "baseURL": "https://your-provider.example/v1", "apiKey": "在本机填写" },
      "models": { "my-model": {} }
    }
  }
}
```

provider 的类型、URL、模型参数应沿用实际账号配置；不要把凭据提交到仓库。桥接在本机读取当前配置，模型列表仅提取标识与显示名；执行时将选定供应商的凭据经私有 stdin 传给其拥有的 ZCode 进程，不写入提示词、卡片、worker 收据或桥接日志。它不会改写桌面或 CLI 的默认模型设置。

若使用 `zcode.dataDir` 或 `ZCODE_STORAGE_DIR`，`config.json` 放在该目录下；bridge 与 worker 必须使用相同目录及账号。不要在已经绑定的群上直接更换数据源。

## 启动与使用

从本仓库构建后：

```bash
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents zcode
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs run --profile my-bot
```

Linux ZCode worker 服务名为 `lark-channel-worker.zcode.my-bot.service`。非 Linux 可用 `worker run --profile my-bot --tool zcode` 配合独立进程托管。Claude worker 的旧命令与服务名保持兼容；同时使用两种工具时分别启动两种 worker。以上命令是手动启动步骤，普通桥接部署不要停止或重启 worker。

私聊机器人发送“新建会话”，选择 **ZCode** 和项目目录。也可从已有会话面板创建工作群；正式名称以 `AA` 开头的 ZCode 会话可自动建群。原生 ID 使用 `sess_...`，不要求 UUID。默认列出独立 CLI 数据源中的会话；桌面账号可复用，但桌面历史不会自动迁入这个数据源。

将机器人拉入协作群后，所有者选择已有个人工作群对应的 ZCode 会话，即可复用 FF 功能；同一来源共享一个 FF 会话，FF 工作群和私聊群不会成为新的来源而递归建群。每次提问通过原生协议读取最新来源记录，在本机生成上下文快照，不向来源提交消息。A2A 的配置和用法见 [接口文档](A2A_API.md)。

## 能力与边界

- 支持新建、恢复、流式文本/思考、工具结果、主动停止和 worker 结果恢复。桥接断开只脱离观察；worker 继续执行，重连从持久化日志更新原群卡片。worker 或主机退出不保证任务继续，不自动重发状态未知的请求。
- 权限模式映射为：只读 → `plan`，工作区 → `build`，完全访问 → `yolo`。这些是 ZCode 原生工具权限模式，不是操作系统级隔离。FF 对同事的业务权限限制仍沿用项目现有提示词与所有者确认流程。
- 尚未实现 ZCode 原生交互问题和权限弹窗的飞书转接；遇到这类原生请求结束本次桥接执行并提示，不自动同意。飞书 `/config` 动态列出多个供应商的模型，也可选择跟随默认；推理强度按各模型的原生档位动态显示，工具没有提供元数据时仅显示“跟随工具默认”；暂不提供 fork 控件。
- 重命名和归档保存在桥接元数据中，原生历史保留；桌面原生标题不会随桥接改名。桌面独立发起的 ZCode 轮次尚不自动回显飞书。避免同时在桌面和飞书写入同一原生会话。
- 附件目前作为本机文件路径提供给 ZCode；尚未接入原生图片输入，不能据此宣称已支持读图。

## 新工具如何接入

工具能力集中在 `src/tools/definitions.ts`，统一标识为 `toolId + sourceId + nativeId`。持久化目录、收件箱和回复账本按工具隔离；Codex 保留原生队列，Claude/ZCode 复用独立 worker。会话历史、改名和归档由 `ToolSessionOperations` 隔离原生格式，飞书消息、FF、私聊群和 A2A 不解析第三方历史文件。

新增工具时注册能力、提供 adapter 与会话操作，并接入 registry；补充原生协议、停止、重连、来源隔离与 A2A 测试。未知工具拒绝加载，不按 Claude 或 Codex 兜底执行。

协议参考：[官方协议设计](https://github.com/zai-org/ZCode/blob/main/docs/design/v2/zcode-protocol-agent-server.md)。上游 main 可能已升级，兼容性以本机 CLI 实际协议及集成测试为准。
