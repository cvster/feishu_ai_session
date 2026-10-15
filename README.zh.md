# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code 或 Codex CLI 打通的轻量 bot。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里和本机编程助手对话，让它读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI。
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上。
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性文本和工具调用，再单独发送最终答案。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **Codex 统一回复同步**：飞书发送端只提交消息；桌面 App 和飞书发起的轮次都由同一个 app-server 快照同步器回复。每个群中的同一会话、同一轮次只对应一张持久化卡片，每 2 秒检查变化；刷新和重启继续更新原卡片。桌面输入会回显到群里，飞书输入不重复回显；首次启用不回放旧历史（建群时配置的最近三轮补同步除外）。旧版双路径留下的卡片不会自动撤回。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **Codex 选项卡**：`requestUserInput` 问题显示为飞书表单，支持多问题、选项和自定义回答；提交直接回答原请求，不创建新轮次。阻塞式问题显示“等待选择”并暂停空闲超时，非阻塞问题继续运行；桌面回答或轮次结束后关闭表单，重连复用原卡片。敏感输入仅在桌面处理。桌面/已有会话的请求需要可连接的共享 app-server（可用 `CODEX_QUEUE_REMOTE` 指定）；独立桌面服务无法只靠历史轮询提取待选项，不会通过竞争性 resume 绕过此限制。标准运行模式的新建/已有任务都由桌面或共享服务执行；显式 stdio 兼容模式才使用原连接回答。
- **Codex 异步问询**：从现有 `thread/read` 快照中的助手消息 `questions` 生成飞书选项卡，复用每 2 秒同步，不另开桌面内部 IPC。答案使用公开 `turn/steer` 和原任务 ID 回传，不排队开启下一轮。桌面回答后同步关闭对应问题，部分回答保留剩余问题；重启复用原卡片，发送回执不确定时禁止自动重发。标准运行模式的新建/已有任务都使用官方队列交给外部 writer；已有桌面任务每 10 秒动态检测同一公开共享 app-server（可用 `CODEX_QUEUE_REMOTE` 指定）是否承载当前任务，可用时启用提交，断开时显示警告并关闭控件，恢复后更新原卡片。提交前再次确认；不抢占会话，也不只凭端点存在判定可用。两端使用相同逻辑。答案文本格式与 App 保持兼容，集中在 `src/session/codex-async-input.ts`，原生问询逻辑不变。
- **Codex 重启保活**：桥接服务退出、重启或重连只停止观察，不中断已提交的任务，也不删除 Codex 队列；启动后由快照同步恢复输出。首次消息先创建并持久化空会话，再由官方队列执行，不依赖桥接子进程保活。“停止/归档”仍是主动取消；桌面/共享 writer 退出及主机重启不在保活范围内。详见 `docs/CODEX_TASK_LIFECYCLE.md`。
- **群名与会话名双向同步**：普通群首次绑定以群名为准；之后每次群名变化只同步一次会话名，后续在 Codex 中改会话名则同步回群名，不在任务结束时强制覆盖。同步记录持久化并识别自身写入的延迟回显；群名每 10 秒检查，会话名复用每 2 秒的快照轮询。若两端在同一次检查前都独立改名，以群名为准。只处理当前机器人明确绑定的普通群，不修改私聊、话题独立会话或其他机器人绑定；名称接口失败时保留原同步记录并重试，不用缓存群名覆盖会话。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。

## 前置条件

- Node.js **>= 20.12.0**
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装

```bash
npm i -g lark-channel-bridge
# 或
pnpm add -g lark-channel-bridge
```

## 首次启动

```bash
lark-channel-bridge run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 如果终端提示，选择本次要初始化的 agent。
5. 成功后配置写入 `~/.lark-channel/config.json`。

没有指定项目目录也可以启动。bridge 会创建一个 profile 托管的默认工作目录；启动后在飞书里发送 `/cd <path>` 切到实际项目。

如果已经有 PersonalAgent app，可以在初始化时传 `--app-id` 跳过创建应用流程；命令会提示输入 App Secret。

```bash
lark-channel-bridge run --app-id cli_xxx
# 或直接初始化并启动后台服务
lark-channel-bridge start --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 同一机器人使用 Codex 和 Claude Code

在私聊“新建会话”卡片中选择 **Codex** 或 **Claude Code**，填写群名和工作目录后创建工作群。默认选择 Codex；工具保存在群绑定中，创建后固定，`/new`、目录切换和服务重启不会把 Claude 群改成 Codex 群。旧命令未传工具时沿用 profile 默认工具。两种 CLI 都需要在运行桥接的本机安装并分别完成登录；缺少 CLI 或恢复失败时不会自动切换工具。

同步器每分钟发现两个工具中正式名称以 `AA` 开头的会话，沿用原会话 ID 和工作目录自动建群。Claude Code 从本地 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）的主会话 JSONL 读取 `custom-title`；子代理、仅问题预览以 AA 开头、未正式命名的会话不会建群。可在 Claude CLI 中用 `/rename AA-项目名` 命名。主动创建的 AA 工作群不会被重复导入。

身份按 `(工具, 本地数据源, 原生会话 ID)` 区分。同名 Codex 和 Claude 会话各有独立群，重名时添加 `（Claude Code）` 或 `（Codex）`，必要时再加编号。名称和 UUID 相同也不会互相恢复或归档。私聊控制台“现有会话”统一列出两种工具的历史。

群内 Claude 请求通过 `--resume <原会话 ID>` 恢复并流式回复。Codex 的现有桌面回复同步继续保留；本阶段不镜像外部 Claude 终端的实时输出。Claude 恢复前使用 Linux `/proc` 检查目录内 Claude 进程，同目录仍有进程时保守拒绝本次请求；请先结束原终端会话再从群内继续。其他平台无法确认占用时也拒绝恢复；该检查不能阻止外部终端在检查后同时启动。桥接内部另用原生会话锁防止同时写入。

Claude 的归档保存在桥接账本中，不删除原生 transcript；已归档会话不会自动重新建群。工具绑定和归档状态保存在 profile 的 `tool-bindings.json`，旧群根据会话目录迁移。不要删除该文件来切换工具或绕过归档。

### 辅助群：关联知识、独立提问

所有者把机器人加入其他群后，机器人会私聊发送关联卡片：选择 Codex 或 Claude Code，再选择已有会话。辅助群继承原会话的项目目录，使用独立的 `FF-{群名}` 会话；首次真实 @ 时创建原生会话，不续跑或修改原会话。个人工作群和自动创建的 AA 群沿用现有行为。

辅助群只响应真实 @ 机器人的人类消息，同事也可提问；话题群的各个话题共用该群的 FF 会话。每次请求附加简短提示词，要求先读取原会话最新进展，没有提问时不主动同步。历史不可读时要求明确说明。权限采用提示词软约束：本机项目只读、不执行项目脚本或构建；外部机器可执行，脚本和产物可部署，其他源码及源码包不外传；允许云端分析和必要代码片段。此模式不提供强制权限隔离。 所有者 Lennox Gao 本人发送的请求按飞书 open_id 识别，在本次提示词中解除上述限制；其他成员的后续请求恢复限制，不继承历史放权。同批消息按所有者与其他成员拆分并顺序处理，同事不会因为消息与所有者相邻而获放权；身份不明的消息保留限制。

回答卡片仅有「停止」「刷新」。任务发起者或所有者可停止当前任务，旧卡片不能停止后续任务；刷新不重新执行问题。所有者在群内 `@机器人 退出`，会停止本群任务及待发送输入，归档 FF 会话并让机器人退群，保留原会话和群历史；失败可重复发送退出指令重试。

私聊通知失败、卡片过期或桥接重启后，可私聊发送 `/aux`，或在私聊控制台点击「待关联辅助群」重新选择。更换关联时，先退出，再重新邀请机器人。状态保存在 profile 的 `auxiliary-groups.json` 与工具绑定账本中。

### Claude 独立执行服务与桥接重启

群内 Claude 任务由独立 worker 执行，飞书桥接只提交请求和同步回复。配置好 profile 后，在 Linux 上先启动 worker：

```bash
lark-channel-bridge worker start --profile lennox-codex
lark-channel-bridge worker status --profile lennox-codex
```

worker 是独立的 `lark-channel-worker.<profile>.service`。`worker start` 不重启已运行的 worker；日常 `lark-channel-bridge restart --profile <profile>` 只重启桥接。未启动或来源不匹配时，Claude 请求明确失败，不降级为桥接子进程执行。其他 supervisor 可用 `worker run --profile <profile>` 单独管理；本阶段完整恢复验证以 Linux 为准。

任务接收记录和输出保存在 profile 的 `execution-worker/jobs`，接收持久化后才启动 Claude。相同请求 ID 不重复执行；空闲超时由 worker 处理，桥接断开不触发超时取消。桥接会保存 debounce 前的输入到 `claude-inbox.json`，重启后核对 worker 收据，再恢复尚未提交的消息。停止命令取消的待处理消息不会重新入队。桥接重启后能继续更新同一卡片或富文本消息，纯文本模式仍只发送最终结果；worker 模式暂不另发 CoT 过程气泡。

`worker-replies.json` 保存回复 ID、卡片序号和发送进度。首发使用稳定的飞书 `uuid` 去重；发送确认丢失后在一小时去重窗口内核对并重试，超过 55 分钟则暂停自动重发，保留输出等待人工核对，避免重复消息。[飞书 SDK 对 uuid 的说明](https://larksuite.github.io/oapi-sdk-java/com/lark/oapi/service/im/v1/model/CreateMessageReqBody.Builder.html)

此机制保障**桥接重启**，不保障 worker 自身重启、退出或主机重启时当前 Claude 进程继续运行。`worker stop` 会停止其任务；worker 重启后已持久化的完整结果仍可补发，未确认完成的任务标记为状态不确定，不自动重跑，也不回滚已产生的操作。worker 启动时读取账户目录和并发上限；升级或调整 worker 应与日常桥接部署分开处理。当前保活和回复恢复覆盖 IM 工作群，不承诺评论入口的回复恢复或外部 Claude 终端直播。

### 多 profile：分别运行多个机器人

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## 命令速查

### 宿主 CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 仅停止当前响应，保留并继续执行后续排队消息；也可点卡片停止按钮（需要公开共享 app-server，Windows 暂不支持桥接停止） |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/codex-turn-sync.json` | Codex 统一回复的轮次游标、卡片 ID 和更新序号（v2 自动迁移旧状态） |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 在 macOS、Ubuntu、Windows 上执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck` 和 `pnpm build`。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
