# ZCode 接入与工具扩展

同一飞书应用可同时连接 Codex、Claude Code 和 ZCode。工作群创建时选择工具；绑定后保持工具、数据源和原生会话 ID，不会在某工具不可用时切换引擎。FF 辅助群、私聊群及 A2A 共用已有执行入口和权限确认流程，不需要额外申请飞书权限。

## 安装和配置

首次安装先完成 [完整安装指引](INSTALL.md) 中的源码构建、profile、后台环境和飞书权限配置，再按本页配置 ZCode。只使用 ZCode 的新 profile 可执行：

```bash
node bin/lark-channel-bridge.mjs profile create my-bot \
  --agent zcode --workspace /absolute/path/to/project
node bin/lark-channel-bridge.mjs setup --profile my-bot
```

已有 profile 跳过创建步骤，所有命令中的 `my-bot` 换成自己的 profile 名。想让飞书输入实时显示在桌面，完成本节原生 CLI 配置后，再完成下方“桌面实时同步：原生远控配对”，最后启动服务。配对不需要额外申请飞书权限。

先安装并配置 [官方 ZCode](https://github.com/zai-org/ZCode)。独立执行验证基线为 Linux、ZCode Agent CLI **0.16.5 / 0.17.0**；桌面配对已在 ZCode **3.16.2 / Agent CLI 0.17.0** 验证。安装脚本的 `--install-clis` 仍只安装 Codex/Claude，ZCode 需单独准备。

`/usr/bin/zcode` 可能是桌面启动器，不能作为 Agent CLI。桥接在常见安装路径找到桌面附带的 `resources/glm/zcode.cjs` 后，使用 Node 运行它；也可以在 profile 中显式配置：

```json
{
  "zcode": {
    "binaryPath": "/absolute/path/to/node",
    "args": ["/opt/ZCode/resources/glm/zcode.cjs"]
  }
}
```

桥接会按原生 CLI 的真实路径识别随包供应商配置（包括桌面安装的 `resources/config/provider/zcode-builtin.json`），不复制其中内容。已显式设置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 时保留该设置；桌面升级后若会话发现失败，先确认该路径仍有效。

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

私聊机器人发送“新建会话”，选择 **ZCode** 和项目目录。也可从已有会话面板创建工作群；正式名称以 `AA` 开头的 ZCode 会话可自动建群。原生 ID 兼容 `sess_...` 和新版桌面的 `session_...`，不要求 UUID。列表读取 `zcode.dataDir` 对应的原生历史；默认安装下桌面与桥接可共用 `~/.zcode/cli/db/db.sqlite`，但它们的 Agent 进程和内存事件流不同，共用数据库不代表已打开的桌面界面会实时刷新。

## 桌面实时同步：原生远控配对

桥接提供可选的原生远控入口，不修改 ZCode 安装包。启用后，通过官方 relay 连接桌面当前窗口，附着到桌面已有的本地工作区 / Agent，在同一原生会话执行飞书输入。远控连接和本机桌面均需保持可用；通信经过 ZCode 外部中继，不是纯本机通信。本机 3.16.2 已实测账号授权、精确工作区附着、模型回答、实时文本事件和带执行身份的停止回执；临时验证会话已通过桌面原生接口归档。该验证确认共享运行时与事件链路，未进行桌面截图比对。

1. 在目标 ZCode 桌面窗口登录账号并打开所需本地项目，点击左侧会话栏底部、设置齿轮旁的手机图标“移动端远程控制”，启用并复制连接链接。
2. 将链接放在当前用户独占、权限 `600` 的本机文件中，不要放进命令参数、群消息、仓库或日志。新版链接只有设备标识，桥接读取桌面当前登录账号，先确认目标设备属于该账号且在线，再向官方接口申请短期 terminal token，通过 `/api/v1/remote/ws2` 连接。旧版 `sid/hash/t` 密钥链接仍兼容。
3. 通过 stdin 导入链接；可用 `--workspace` 做只读连接与工作区验证，不提交模型输入：

```bash
node bin/lark-channel-bridge.mjs zcode pair --profile my-bot \
  --workspace /absolute/project/path < /absolute/private/zcode.link
```

命令保存独立的 `600` 连接文件，profile 中只保存 `zcode.remoteControlFile` 路径，不回显链接。新版账号登录态从 `zcode.modelConfigPath` 旁的 `credentials.json` 读取，默认 `~/.zcode/v2/credentials.json`；按原生 `enc:v1:` 格式解密，保持原文件不变。登录 JWT 只用于官方 HTTPS 授权接口，不进入链接、配置、提示词或日志，短期 terminal token 只在内存使用。只读验证仍会建立一个远控终端，可能替换已连接的手机远控；不要同时使用桥接和手机争用同一个配对入口。重新导入时写入新的凭据文件，已经加载旧配置的 worker 不受导入动作直接影响。命令不重启服务；配置后需单独升级 / 重启 ZCode worker，并重启桥接。旧 worker 或执行模式不匹配时拒绝派发。

首次安装且尚未启动服务时，完成配对后执行：

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs start --profile my-bot
```

已有部署切换配对模式或升级 ZCode 执行代码时，先将构建产物部署到服务实际使用的目录，再从该目录执行以下命令。停止 ZCode worker 会中断其任务，应作为单独升级操作；其他工具的 worker 无需重启。`worker start` 对运行中的服务是幂等操作，不能代替重启：

```bash
node bin/lark-channel-bridge.mjs stop --profile my-bot
node bin/lark-channel-bridge.mjs worker stop --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool zcode
node bin/lark-channel-bridge.mjs start --profile my-bot
node bin/lark-channel-bridge.mjs status --profile my-bot
```

非 Linux 环境由自己的进程管理器按相同顺序重启 `worker run --profile my-bot --tool zcode` 和桥接。首次验收在 ZCode 桌面打开相同的本地项目，再从对应飞书工作群发送简单问题，检查同一会话的输入、回复与停止操作；桌面直接发起的新消息按下方“桌面消息回推个人工作群”同步。

支持两种官方链接：旧版含 `hash/t`，使用原生 HMAC challenge；3.16.2 链接只含设备标识，使用账号授权 V2。V2 在每次连接前读取桌面现有登录态，先通过官方接口确认该设备属于当前账号且在线，再申请短期 `terminal` token，连接官方 `/api/v1/remote/ws2`；不注册 / 删除设备，不申请 `device` token。JWT 只发送给固定官方授权接口，短期 token 仅用于原生 WebSocket 握手，不写入链接文件、profile、提示词或日志。账号与凭据目录默认使用 `~/.zcode/v2`，也可沿用 `zcode.modelConfigPath` 所指目录；自定义原生凭据加密密钥仍需通过 `ZCODE_CREDENTIAL_SECRET` 提供。桌面登录失效时由用户在桌面重新登录，桥接不修改或导出桌面凭据。

配对模式每个 ZCode worker 同时只执行一个任务，不同群共用该入口。同一凭据文件还有跨进程连接锁；不要为多个 profile 分别导入同一个配对入口，它们仍可能争用同一远控终端。项目必须在该桌面窗口中存在唯一匹配的本地工作区；不按第一个工作区兜底，也不会把本地绑定路由到同路径的 SSH 工作区。

模型菜单按项目从桌面原生会话读取当前可用模型和推理档位，不套用独立 CLI 的供应商列表。刷新由同一个 worker 在空闲时串行处理；正在执行时需先完成或停止，再刷新，避免模型查询替换正在使用的远控连接。项目尚无会话时，会创建并归档一个无输入的临时会话以读取原生能力。

新建和恢复会话未显式指定模型时，保留桌面自己的模型选择；不使用本机 CLI 旧默认覆盖桌面。显式模型选择只通过原生供应商 / 模型 ID 交给桌面；供应商注册表和 API Key 不经 relay 传输，仍由桌面管理。新建且未指定模型时使用桌面自己的默认模型，续聊保持原会话模型，不强制套用独立 CLI 的默认供应商。飞书 CLI、MCP、环境变量及工具权限使用桌面环境，不能继承独立 worker 子进程的环境注入。FF 的现有提示词与所有者确认继续由桥接入口处理。

连接失败不会回退到独立 app-server；发送后失联视为状态未知，不重发输入，也不会为了重连停止桌面任务。下一次新请求可重新建立连接。停止命令携带本轮事件报告的 `foregroundExecutionId`，未取得该身份时明确报错，不停止其他轮次。模型运行时鉴权请求交给桌面的自动鉴权处理器，桥接继续观察；原生权限或用户交互仍需在桌面处理，遇到这类交互时飞书观察结束并标记状态未知，桌面任务未被取消，桥接不自动同意或重发。

会话列表、历史快照、桥接别名以及原生复制仍使用已有本机数据源；配对不会自动搬迁历史、更改已有 `sourceId` 或把桌面其他机器的历史导入本机。桌面新轮次的回推独立读取本机原生记录，不通过配对终端订阅，规则见下文。

暂不使用远控时，移除 profile 的 `zcode.remoteControlFile` 并单独重启 ZCode worker / 桥接，即恢复独立执行。要撤销已复制链接的远控授权，在 ZCode 桌面刷新 / 撤销远控入口；只删除桥接配置不代表已撤销桌面的链接凭据。

协议来源：[官方远控架构](https://github.com/zai-org/ZCode/blob/main/docs/web-remote-control/web-remote-control-architecture.md)、[relay 协议与工作区入口](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/web-remote-control.ts)、[Channel RPC 格式](https://github.com/zai-org/ZCode/blob/main/packages/rpc/src/serialization.ts)。实现没有打补丁或注入桌面进程。

将机器人拉入协作群后，所有者可选择任意未归档的原始 ZCode 会话，不要求先创建个人工作群。列表按 AA 会话、其他个人工作群会话、其余会话排序，同类按最近更新排序。直接续聊所选原会话，不创建 FF、读取来源快照或另建 FF 工作群。已有 FF 入口升级后改绑原会话，旧历史保留。A2A 的配置和用法见 [接口文档](A2A_API.md)。

## 桌面消息回推个人工作群

绑定个人工作群后，桥接每约 2 秒通过本机 ZCode Agent CLI 读取原生消息记录，将桌面新提问和回答同步到该群；回答持续更新同一张卡片。只观察已有会话，不向模型再次提交问题、不修改模型配置，也不连接或占用远控配对终端。飞书发起的任务仍由 worker 回复。无需新权限或额外配置，只需更新并重启桥接，无需为此升级 worker。

首次启用或重新绑定建立历史基线，不补发已有消息，包括当时已开始的轮次；后续重启沿用 `profiles/<profile>/zcode-turn-sync.json` 的去重和卡片更新序号。不要删除该文件来排障。

仅向绑定的活跃个人工作群回推。开放群、私聊群、旧 FF 工作群、话题及归档群不接收桌面内容广播。根据原生输入准入元数据确认桌面来源，飞书来源或来源不明的旧格式不转发；不按问题文本猜测来源，也不会转发内部隐藏提醒。桌面任务的停止仍在 ZCode 桌面操作，回推卡片不提供无效的停止按钮；飞书发起任务的停止按钮保持原行为。模型原生交互仍在桌面处理。

## 会话名与群名

桌面配对模式下，新建会话会在首条输入持久化后写入与个人工作群一致的原生标题；从其他工具复制时，沿用新群的完整名称，例如 `AA-项目（ZCode）`。已有会话续聊不反复覆盖标题。空会话暂未持久化或改名尚未成功时，保持已接受任务的观察，随后由名称同步重试，不为改名重发输入。

绑定的活跃个人工作群每约 10 秒同步一次名称：修改飞书群名会更新 ZCode 原生会话名，修改桌面会话名会更新飞书群名。首次启用以群名为准，修复旧版仅保存桥接标签造成的标题不一致；双方同时改名时群名优先。FF 开放群、FF 个人工作群、私聊辅助群、话题和归档群不参与此名称同步。ZCode 正在执行时暂缓原生改名，结束后重试，不为改名替换正在使用的远控连接。

该能力需要同时更新桥接并单独升级 ZCode worker，健康接口提供 `zcodeSessionNames` 标记。独立 CLI 模式仍保留桥接本地标签，不支持桌面标题双向同步。

## 能力与边界

- 支持新建、恢复、流式文本/思考、工具结果、主动停止和 worker 结果恢复。桥接断开只脱离观察；worker 继续执行，重连从持久化日志更新原群卡片。worker 或主机退出不保证任务继续，不自动重发状态未知的请求。
- 权限模式映射为：只读 → `plan`，工作区 → `build`，完全访问 → `yolo`。这些是 ZCode 原生工具权限模式，不是操作系统级隔离。FF 对同事的业务权限限制仍沿用项目现有提示词与所有者确认流程。
- 尚未实现 ZCode 原生交互问题和权限弹窗的飞书转接；遇到这类原生请求结束本次桥接执行并提示，不自动同意。飞书 `/config` 动态列出多个供应商的模型，也可选择跟随默认；推理强度按各模型的原生档位动态显示，工具没有提供元数据时仅显示“跟随工具默认”；支持通过“复制会话”按钮调用原生 `session/fork`，从最新对话消息复制历史、供应商、模型与档位，并创建独立工作群；不使用会回退文件的 checkpoint 目标；运行中的任务需先停止再复制。飞书发起的普通工作群任务在运行及完成卡片中保留停止按钮；FF 辅助群仍只显示停止和刷新。
- 独立 CLI 模式的重命名及桥接归档保存在桥接元数据中，原生历史保留；桌面配对模式的原生标题与群名同步规则见上文。桌面发起的新轮次可回显对应个人工作群；避免同时在桌面和飞书写入同一原生会话。
- 附件目前作为本机文件路径提供给 ZCode；尚未接入原生图片输入，不能据此宣称已支持读图。

## 工作群头像

Codex、Claude、ZCode 均使用各自专用头像；手动创建、AA 自动建群、FF 个人工作群及新建的私聊群复用同一个头像入口。原有个人工作群在同步时补设工具头像；每个连接只补设一次，失败下次重试，不创建重复群。外部辅助群保持原头像。新注册工具必须同时提供头像，否则类型检查失败。

## 新工具如何接入

工具能力集中在 `src/tools/definitions.ts`，统一标识为 `toolId + sourceId + nativeId`。持久化目录、收件箱和回复账本按工具隔离；Codex 保留原生队列，Claude/ZCode 复用独立 worker。会话历史、改名和归档由 `ToolSessionOperations` 隔离原生格式，飞书消息、FF、私聊群和 A2A 不解析第三方历史文件。

新增工具时注册能力、提供 adapter 与会话操作，并接入 registry；补充原生协议、停止、重连、来源隔离与 A2A 测试。未知工具拒绝加载，不按 Claude 或 Codex 兜底执行。

协议参考：[官方 Agent 协议](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol/index.ts)。上游 main 可能已升级，兼容性以本机 CLI 实际协议及集成测试为准。
