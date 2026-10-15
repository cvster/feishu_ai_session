# CodexFeishu · 飞书 AI 助手桥接

将飞书 / Lark 群聊接入本机 Codex 和 Claude Code。私聊机器人创建或管理会话，在工作群中提问、处理图片和文件、执行项目任务；也可以把机器人加入已有协作群，关联一个已有会话作为背景。

本项目基于原始 GitHub 项目 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（原名 `feishu-claude-code-bridge`） 二次开发，保留原项目的版权与许可证说明。

**本项目开发者：Lennox Gao。** 使用过程中有问题、建议或需求，欢迎联系 Lennox Gao。

本仓库包含个人工作群、AA 会话自动建群、共享 FF 辅助会话、折叠回复和独立 Claude worker 等定制功能。使用本仓库版本请按下文从源码构建；公开 npm 包不保证包含这些改动。

- [飞书权限申请清单](docs/FEISHU_PERMISSIONS.md)：权限标识、申请用途、事件订阅与验收步骤。
- [详细配置与排错](README.zh.md)：权限模式、访问控制、会话与日志等进阶说明。
- [多服务目录说明](docs/MONOREPO.md)：飞书桥接、共享 Codex core 与独立 Web 服务的边界。

## 主要功能

- 给Codex或者Claude会话创建个人飞书工作群，每个群对应一个会话，在群里发消息等同于ai会话中聊天。
- 一个机器人同时支持 Codex 和 Claude Code，创建工作群时选择工具与项目目录。
- 以 `AA` 开头的已有会话可自动创建同名的飞书工作群。
- 把机器人加入开放协作群后，由所有者在私聊选择关联ai会话，创建 `FF-{原会话名}` 辅助会话。辅助群只响应真实 `@机器人` 的消息；同事可提问，回答仅回到提问群。
- 辅助群默认简短回复，不提及来源会话和内部读取过程。长正文、代码和工具记录默认折叠；结束后的状态与按钮也放入折叠区。
- Codex 通过原生队列提交、统一同步桌面与飞书回复；Claude 由独立 worker 执行。桥接重启后可继续同步已有结果。

## 环境要求

| 项目      | 要求                                               |
| ------- | ------------------------------------------------ |
| Node.js | `>= 20.12.0`；本机部署已验证 Node 24                     |
| pnpm    | `10.33.0`，以 `package.json` 的 `packageManager` 为准 |
| 编程助手    | 至少一个已安装并登录的 `codex` 或 `claude`；需要两个工具时分别登录       |
| 飞书应用    | 启用机器人能力，配置权限、事件与回调，并发布应用版本                       |
| 飞书 CLI  | `lark-cli`；首次交互启动会检查安装及当前 profile 的应用绑定          |
| 部署账户    | 可读写会话状态目录，并能访问对应项目、CLI 登录信息和网络                   |

Codex 的发送、队列与选项交互依赖兼容的原生接口；桌面已有任务的问询需要可访问的公开共享 app-server，可按环境配置 `CODEX_QUEUE_REMOTE`。只安装 CLI 并不保证桌面私有连接上的交互可用。详见 [Codex 任务生命周期](docs/CODEX_TASK_LIFECYCLE.md)。

Claude 独立 worker 的系统服务和重启恢复目前以 Linux 为主要验证环境。不要把桥接重启保活理解为 worker、Codex writer 或主机重启也能保活。

## 安装与首次启动

### 1. 下载和构建

在计划长期保留的目录安装，不要把后台服务指向 `npx` 临时缓存。

```bash
git clone https://github.com/cvster/CodexFeishu.git
cd CodexFeishu

corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 生成根目录 `dist/` 的飞书桥接产物，同时准备共享 core 产物；不会启动或部署 Web 服务。

### 2. 创建机器人配置

下面的 `my-bot` 是自定义 profile 名，`/absolute/path/to/project` 请替换为本机真实项目目录。

```bash
node bin/lark-channel-bridge.mjs profile create my-bot \
  --agent codex \
  --workspace /absolute/path/to/project

node bin/lark-channel-bridge.mjs profile use my-bot
```

不传 App ID 时进入扫码向导。如果已有飞书应用，可使用：

```bash
node bin/lark-channel-bridge.mjs profile create my-bot \
  --agent codex \
  --app-id cli_xxx \
  --workspace /absolute/path/to/project
```

按提示交互输入 App Secret；不要把 Secret 写入命令历史或提交到仓库。Lark 国际版加 `--tenant lark`。应用权限与事件订阅按 [权限清单](docs/FEISHU_PERMISSIONS.md) 配置，修改后需发布生效。

### 3. 启动 Claude worker 与桥接

需要在工作群中使用 Claude 时，先启动该 profile 的 worker。只使用 Codex 可跳过 worker 两条命令。

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot
node bin/lark-channel-bridge.mjs worker status --profile my-bot

node bin/lark-channel-bridge.mjs run --profile my-bot
```

`run` 用于前台调试。首次启动会检查 `lark-cli`；无交互的系统服务不会自动安装缺失的 CLI，可预先运行 `npm install -g @larksuite/cli`。桥接会为 profile 绑定对应应用，agent 内的 CLI 自动使用该 profile，默认应用机器人身份。

确认日志显示机器人已连接后，私聊它发送“新建会话”。完成前台验证后按 `Ctrl-C` 退出，再启动后台服务。

## 主要用法

### 个人工作群（含 AA 会话群）

AA 会话群就是个人工作群，不作为单独的群类型。个人工作群可以从私聊控制台创建，也可以由 `AA` 前缀会话自动建群；两者适用相同的工作群功能与权限规则。本文仅区分个人工作群和 FF 辅助群。

1. 私聊机器人发送“新建会话”或“控制台”。本版私聊主要用于会话与工作群管理。
2. 在卡片中选择 **Codex** 或 **Claude Code**，填写工作群名和本机项目目录。
3. 创建后进入对应群提问；需要 @ 的群请真实选择并 @ 机器人。
4. 在普通工作群中用 `/cd`、`/ws`、`/config` 等命令调整目录或偏好。群创建后工具固定，不会因重启或重置切换引擎。

桌面 / CLI 中正式名称以 `AA` 开头的会话会被定期发现并创建工作群，沿用原会话 ID 与工作目录。例如 Claude 可通过 `/rename AA-项目名` 设置正式名称。已绑定的会话不重复建群；同名但不同工具、数据源或 ID 的会话分别处理。

### 把机器人加入已有协作群

1. 由应用所有者把机器人拉入目标群。
2. 机器人私聊所有者：选择工具，再选择要关联的已有会话。
3. 辅助群继承来源会话的项目目录；首次真实 @ 时创建或复用 `FF-{原会话名}`。
4. 群成员真实 `@机器人` 后提问。未 @、`@所有人` 或其他机器人消息不处理。

同一来源按 **工具 + 本地数据源 + 原生会话 ID** 区分。多个群关联同一来源时，共用一个 FF 历史上下文，因此不要把需要互相隔离的讨论绑定到同一来源；回答仍只发送到提问群。原会话仅作为背景读取，不被续跑或修改。最新进展在每次提问时读取，没有后台主动同步任务。

通知失败、旧卡片过期或桥接重启后，所有者私聊发送 `/aux`，或点击控制台“待关联辅助群”重新选择。

辅助群保留「停止」「刷新」两个按钮：运行时在外侧，结束后与状态一起收进详情区。长回答默认收起，点“查看详细说明”展开。默认回复不超过 200 字、5 行；明确要求详情时可给完整内容。提示词约束属于软限制，不保证模型输出一定满足字数或隐私表达要求。

所有者在辅助群真实 `@机器人 退出` 后，停止并撤销本群请求、让机器人退群；其他关联群继续使用 FF，最后一个群退出才归档 FF。原会话和历史文件保留。更换关联时先退出，再重新邀请。

### 图片和文件

群成员可在提问时附带图片、文件或引用消息。桥接将附件下载到本机后交给 agent。

要求机器人“把脚本发到本群”时，每次请求已注入当前 `chat_id` 和文件发送指引，使用当前应用的机器人身份，不需要再向用户索要群链接。同一个 FF 被多个群复用时，也以本次请求的群 ID 为准。文件成功发送后才应报告已发送。

云文档评论是按需功能：云文档评论按文档权限生效，支持的文档中 @ 机器人可在原评论线程回复；需另外配置评论权限和事件，详见权限清单。

### 常用指令

以下工作群命令用于个人工作群；辅助群只提供停止、刷新和所有者退出。私聊使用控制台与 `/aux`。

| 指令                                    | 用途                       |
| ------------------------------------- | ------------------------ |
| “新建会话” / “控制台”                        | 私聊创建、关联或管理会话群            |
| `/aux`                                | 私聊重新获取待关联辅助群卡片           |
| `/status`                             | 查看当前 profile、工具、目录与状态    |
| `/new`、`/reset`                       | 重置当前个人工作群会话              |
| `/cd /absolute/path`                  | 切换项目目录                   |
| `/ws list`、`/ws save 名称`、`/ws use 名称` | 查看、保存和切换工作空间             |
| `/resume`                             | 选择兼容的已有会话                |
| `/config`                             | 修改模型、展示、访问及 CLI 身份偏好     |
| `/stop`                               | 停止本群当前响应；共享 FF 不停止其他群的任务 |
| `/refresh`                            | 刷新已有回复状态，不重跑任务           |
| `/timeout 10`、`/timeout off`          | 设置或关闭个人工作群空闲超时           |
| `/invite group`、`/invite user @同事`    | 管理员在个人工作群开放群或用户访问        |
| `/doctor`                             | 查看诊断报告                   |
| `/help`                               | 查看帮助                     |

### 执行权限

普通 profile 的 `permissions.defaultAccess` 与 `maxAccess` 默认均为 `full`；可配置为 `workspace` 或 `read-only`。这些执行权限与飞书 OpenAPI scope 是两回事。

辅助群提示词整体采用 JSON，将可信的 `context` / `rules`、来源入口和 `user_input` 分字段保存。同一个 FF 每 10 次请求为一轮：第 1 次完整，其余 9 次精简；合并的一批消息计一次。计数持久化，重启继续；新原生 FF 或尚未创建成功时先发完整规则。每次仍携带当前群 ID、来源读取入口和当前发送者权限。JSON 用于避免文本拼接混淆，不能保证阻止模型越狱，也不代替执行权限控制。

辅助群的默认限制是：本机项目只读、不执行本机项目脚本或构建；可在外部机器执行，脚本和产物可部署，其他源码及源码包不外传。应用所有者本人发送的请求依据真实 open\_id 在本次提示词中放宽限制；同事后续请求重新附加限制，不依靠姓名判断身份。

旧版 `sandbox` 字段仍可读取；保存 profile 后迁移到 `permissions`，新配置请使用 `permissions`。

这是模型行为约束，不是独立沙箱、只读挂载或文件外传拦截。详情见 [权限与访问控制](README.zh.md#权限模式)。

## 部署为后台服务

在上述固定安装目录执行：

```bash
node bin/lark-channel-bridge.mjs start --profile my-bot
node bin/lark-channel-bridge.mjs status --profile my-bot
```

每个 profile 有独立服务。服务记录当前 Node 和 CLI 入口的绝对路径。更换安装目录或 Node 路径后，应从新路径重新执行 `start` 注册服务。

| 平台      | 桥接服务                                                 |
| ------- | ---------------------------------------------------- |
| Linux   | 用户级 systemd：`lark-channel-bridge.bot.my-bot.service` |
| macOS   | launchd：`ai.lark-channel-bridge.bot.my-bot`          |
| Windows | 计划任务：`LarkChannelBridge.Bot.my-bot`                  |

Linux Claude worker 使用独立的 `lark-channel-worker.my-bot.service`，启动命令见前文。需要退出登录后继续运行时，可由管理员为部署账户配置 systemd linger。

```bash
# 日常只重启飞书桥接
node bin/lark-channel-bridge.mjs restart --profile my-bot

# 查看状态或停止桥接
node bin/lark-channel-bridge.mjs status --profile my-bot
node bin/lark-channel-bridge.mjs stop --profile my-bot
```

`worker stop` 会停止 Claude 任务，不属于普通桥接重启步骤；也不要连带重启 Codex Desktop、共享 writer/app-server 或 Web 服务。

## 升级、回滚与部署目录

### 从源码升级

升级前保存当前可回滚的构建产物和服务文件。不要把未提交代码、配置、密钥、运行账本或日志放进部署提交。

```bash
cd /path/to/CodexFeishu
git pull --ff-only
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build

node bin/lark-channel-bridge.mjs restart --profile my-bot
node bin/lark-channel-bridge.mjs status --profile my-bot
# 若启用了 Claude，仅核对 worker，不重启它
node bin/lark-channel-bridge.mjs worker status --profile my-bot
```

部署前检查版本、依赖与构建；部署后检查服务健康和 WebSocket 连接。无需把读取任务列表或等待全部任务结束作为日常桥接重启的前置条件。

源码和运行目录分开时，将已验证的 `dist/` 部署到固定运行目录，并保留对应的 `bin/`、`package.json`、锁文件、生产依赖及许可证。仅在依赖一致时直接替换 `dist/`；依赖有变化时按对应版本安装依赖。采用临时目录校验、备份及替换产物后，只重启目标桥接服务。回滚恢复上一版构建，不用旧备份覆盖当前会话、消息队列和回复账本。

本次维护机器的路径为：

| 路径                                             | 用途                   |
| ---------------------------------------------- | -------------------- |
| `/home/pc/code/CodexFeishu`                    | 项目源码                 |
| `/home/pc/lark-coding-agent-bridge`            | 已部署运行目录              |
| `/home/pc/.lark-channel/profiles/lennox-codex` | 当前 profile 的会话、绑定和日志 |

其他部署者应使用自己的路径、profile 和飞书应用，无需沿用这些本机名称。

## 配置、数据与排错

默认数据根目录为 `~/.lark-channel`，可通过 `LARK_CHANNEL_HOME` 设置。所有运行状态与代码目录分开保存。

| 路径（相对于数据根目录）                               | 内容                      |
| ------------------------------------------ | ----------------------- |
| `config.json`                              | 所有 profile 的配置          |
| `profiles/<profile>/secrets.enc`           | 应用凭据                    |
| `profiles/<profile>/lark-cli/`             | profile 隔离的飞书 CLI 身份与授权 |
| `profiles/<profile>/sessions.json*`        | 会话状态、目录索引与归档            |
| `profiles/<profile>/tool-bindings.json`    | 工具与共享 FF 绑定             |
| `profiles/<profile>/auxiliary-groups.json` | 辅助群关联和生命周期              |
| `profiles/<profile>/codex-turn-sync.json`  | Codex 回复卡片、游标与更新序号      |
| `profiles/<profile>/execution-worker/`     | Claude worker 收据与输出日志   |
| `profiles/<profile>/logs/`                 | 桥接日志与 `daemon/` 服务日志    |

常见问题：

- **群里不响应**：检查应用已发布、可用范围包含用户、机器人在群内、真实 @ 和访问名单；辅助群还需所有者完成关联。
- **辅助群未收到关联卡片**：检查机器人进群事件，私聊发送 `/aux` 获取待办。
- **Axios 400 / 权限不足**：查看业务错误码与缺失 scope，按 [权限清单](docs/FEISHU_PERMISSIONS.md) 补齐并发布。不要只根据 HTTP 400 猜测原因。
- **CLI 身份或文件发送失败**：核对当前 profile 的应用绑定；本地文件使用相对于当前目录的路径，不要改绑到他人的应用或读取密钥来绕过。
- **Claude 执行失败**：确认 `claude` 已登录、worker 正常，数据源和应用与桥接一致。已有同目录 Claude 终端占用会阻止恢复，不会自动切换工具。
- **卡片长时间不更新**：检查桥接服务与日志；使用刷新查看现有结果，避免因发送确认不明而反复提交同一任务。

```bash
node bin/lark-channel-bridge.mjs --help
node bin/lark-channel-bridge.mjs profile list
node bin/lark-channel-bridge.mjs status --profile my-bot
# Linux 服务日志文件
tail -n 60 ~/.lark-channel/profiles/my-bot/logs/daemon/daemon-stderr.log
```

## 开发与许可证

从仓库根目录运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。本次只维护文档时，检查命令是否存在、相对链接及 Markdown 格式即可。

飞书桥接与 `packages/codex-core` 使用 [MIT](LICENSE)。独立的 `apps/web-app` 保留自身 GPLv3 许可证、依赖和部署流程；更新飞书桥接不会自动更新该 Web 服务。详见 [目录与许可证边界](docs/MONOREPO.md)。
