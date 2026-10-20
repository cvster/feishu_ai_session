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

模型列表和账号配置动态读取，默认读取桌面当前的 `~/.zcode/v2` 配置目录（兼容新旧格式）；无需把供应商和密钥复制到独立 CLI。可通过 `zcode.modelConfigPath` 显式指定配置来源。完整来源优先级、刷新和失效处理见 [动态模型列表](MODELS.md)。独立 CLI 的 `~/.zcode/cli/config.json` 仍受支持，权限设为 `600`，示意：

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

provider 的类型、URL、模型参数应沿用实际账号配置；不要把凭据提交到仓库。桥接在本机读取当前配置，模型列表仅提取标识、显示名和推理档位；执行时将选定供应商的凭据经私有 stdin 传给其拥有的 ZCode 进程，不写入提示词、卡片、worker 收据或桥接日志。它不会改写桌面或 CLI 的默认模型设置。

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

涉及 ZCode 执行适配器的修复需要**单独升级 ZCode worker**；只重启桥接不会更新已加载的 worker 代码。健康接口的 `zcodeRegistryResume` 标记用于阻止将新请求交给仍会覆盖原会话供应商的旧 worker，不影响已经接收的任务。

本机曾因旧 `provider_config.json` 残留而读到了 `new-provider`；桌面实际使用 `config.json` 中的 `tars`/`TarsC`。部署这次修复时，应将 profile 的 `zcode.modelConfigPath` 改为当前桌面目录（本机 `/home/pc/.zcode/v2`）或实际使用的文件，保留其他 profile 字段及独立会话数据目录。不要将供应商名称当作原生 ID 重新创建供应商。

私聊机器人发送“新建会话”，选择 **ZCode** 和项目目录。也可从已有会话面板创建工作群；正式名称以 `AA` 开头的 ZCode 会话可自动建群。原生 ID 使用 `sess_...`，不要求 UUID。列表读取 `zcode.dataDir` 对应的原生历史；默认安装下桌面与桥接可共用 `~/.zcode/cli/db/db.sqlite`，但它们的 Agent 进程和内存事件流不同，共用数据库不代表已打开的桌面界面会实时刷新。

## 桌面实时同步：原生远控配对（待本机联调）

桥接提供可选的原生远控入口，不修改 ZCode 安装包。启用后，通过官方 relay 连接桌面当前窗口，附着到桌面已有的本地工作区 / Agent，在同一原生会话执行飞书输入。远控连接和本机桌面均需保持可用；通信经过 ZCode 外部中继，不是纯本机通信。当前协议测试已覆盖鉴权、RPC、订阅、停止和断连；实际桌面的配对、模型问答和界面实时显示仍需完成本机联调后确认。

1. 在目标 ZCode 桌面窗口打开所需本地项目，在“远程控制”中启用并复制连接链接。
2. 将链接放在当前用户独占、权限 `600` 的本机文件中。链接包含配对凭据，不要放进命令参数、群消息、仓库或日志。
3. 通过 stdin 导入链接；可用 `--workspace` 做只读连接与工作区验证，不提交模型输入：

```bash
node bin/lark-channel-bridge.mjs zcode pair --profile my-bot \
  --workspace /absolute/project/path < /absolute/private/zcode.link
```

命令保存独立的 `600` 凭据文件，profile 中只保存 `zcode.remoteControlFile` 路径，不回显链接。只读验证仍会建立一个远控终端，可能替换已连接的手机远控；不要同时使用桥接和手机争用同一个配对入口。重新导入时写入新的凭据文件，已经加载旧配置的 worker 不受导入动作直接影响。命令不重启服务；配置后需单独升级 / 重启 ZCode worker，并重启桥接。旧 worker 或执行模式不匹配时拒绝派发。

配对模式每个 ZCode worker 同时只执行一个任务，不同群共用该入口。同一凭据文件还有跨进程连接锁；不要为多个 profile 分别导入同一个配对入口，它们仍可能争用同一远控终端。项目必须在该桌面窗口中存在唯一匹配的本地工作区；不按第一个工作区兜底，也不会把本地绑定路由到同路径的 SSH 工作区。

模型选择只通过原生供应商 / 模型 ID 交给桌面；供应商注册表和 API Key 不经 relay 传输，仍由桌面管理。飞书 CLI、MCP、环境变量及工具权限使用桌面环境，不能继承独立 worker 子进程的环境注入。FF 的现有提示词与所有者确认继续由桥接入口处理。

连接失败不会回退到独立 app-server；发送后失联视为状态未知，不重发输入，也不会为了重连停止桌面任务。下一次新请求可重新建立连接。停止命令携带本轮事件报告的 `foregroundExecutionId`，未取得该身份时明确报错，不停止其他轮次。原生权限或用户交互由桌面处理；遇到交互时飞书观察结束并标记状态未知，桌面任务未被取消，桥接不自动同意或重发。

会话列表、历史快照、桥接别名以及原生复制仍使用已有本机数据源；配对不会自动搬迁历史、更改已有 `sourceId` 或把桌面其他机器的历史导入本机。配对模式下桌面直接发起的轮次仍不自动回推飞书。

暂不使用远控时，移除 profile 的 `zcode.remoteControlFile` 并单独重启 ZCode worker / 桥接，即恢复独立执行。要撤销已复制链接的远控授权，在 ZCode 桌面刷新 / 撤销远控入口；只删除桥接配置不代表已撤销桌面的链接凭据。

协议来源：[官方远控架构](https://github.com/zai-org/ZCode/blob/main/docs/web-remote-control/web-remote-control-architecture.md)、[relay 协议与工作区入口](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/web-remote-control.ts)、[Channel RPC 格式](https://github.com/zai-org/ZCode/blob/main/packages/rpc/src/serialization.ts)。实现没有打补丁或注入桌面进程。

将机器人拉入协作群后，所有者可选择任意未归档的原始 ZCode 会话，不要求先创建个人工作群。列表按 AA 会话、其他个人工作群会话、其余会话排序，同类按最近更新排序。同一来源共享一个 FF 会话，FF 工作群和私聊群不会成为新的来源而递归建群。每次提问通过原生协议读取最新来源记录，在本机生成上下文快照，不向来源提交消息。A2A 的配置和用法见 [接口文档](A2A_API.md)。

## 能力与边界

- 支持新建、恢复、流式文本/思考、工具结果、主动停止和 worker 结果恢复。桥接断开只脱离观察；worker 继续执行，重连从持久化日志更新原群卡片。worker 或主机退出不保证任务继续，不自动重发状态未知的请求。
- 权限模式映射为：只读 → `plan`，工作区 → `build`，完全访问 → `yolo`。这些是 ZCode 原生工具权限模式，不是操作系统级隔离。FF 对同事的业务权限限制仍沿用项目现有提示词与所有者确认流程。
- 尚未实现 ZCode 原生交互问题和权限弹窗的飞书转接；遇到这类原生请求结束本次桥接执行并提示，不自动同意。飞书 `/config` 动态列出多个供应商的模型，也可选择跟随默认；推理强度按各模型的原生档位动态显示，工具没有提供元数据时仅显示“跟随工具默认”；支持通过“复制会话”按钮调用原生 `session/fork`，从最新对话消息复制历史、供应商、模型与档位，并创建独立工作群；不使用会回退文件的 checkpoint 目标；运行中的任务需先停止再复制。普通工作群在运行及完成卡片中保留停止按钮；FF 辅助群仍只显示停止和刷新。
- 重命名和归档保存在桥接元数据中，原生历史保留；桌面原生标题不会随桥接改名。桌面独立发起的 ZCode 轮次尚不自动回显飞书。避免同时在桌面和飞书写入同一原生会话。
- 附件目前作为本机文件路径提供给 ZCode；尚未接入原生图片输入，不能据此宣称已支持读图。

## 工作群头像

Codex、Claude、ZCode 均使用各自专用头像；手动创建、AA 自动建群、FF 个人工作群及新建的私聊群复用同一个头像入口。原有个人工作群在同步时补设工具头像；每个连接只补设一次，失败下次重试，不创建重复群。外部辅助群保持原头像。新注册工具必须同时提供头像，否则类型检查失败。

## 新工具如何接入

工具能力集中在 `src/tools/definitions.ts`，统一标识为 `toolId + sourceId + nativeId`。持久化目录、收件箱和回复账本按工具隔离；Codex 保留原生队列，Claude/ZCode 复用独立 worker。会话历史、改名和归档由 `ToolSessionOperations` 隔离原生格式，飞书消息、FF、私聊群和 A2A 不解析第三方历史文件。

新增工具时注册能力、提供 adapter 与会话操作，并接入 registry；补充原生协议、停止、重连、来源隔离与 A2A 测试。未知工具拒绝加载，不按 Claude 或 Codex 兜底执行。

协议参考：[官方 Agent 协议](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol/index.ts)。上游 main 可能已升级，兼容性以本机 CLI 实际协议及集成测试为准。
