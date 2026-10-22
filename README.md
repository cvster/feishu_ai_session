# CodexFeishu · 飞书 AI助手桥接

将飞书 / Lark 群聊接入本机 Codex、Claude Code、ZCode、Kilo 和 DeepSeek Harness（DSH）。私聊机器人创建或管理会话，在工作群中提问、处理图片和文件、执行项目任务；也可以把机器人加入已有协作群，关联一个已有会话作为背景。

本项目基于原始 GitHub 项目 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（原名 `feishu-claude-code-bridge`） 二次开发，保留原项目的版权与许可证说明。

**本项目开发者：Lennox Gao。** 使用过程中有问题、建议或需求，欢迎联系 Lennox Gao。

本仓库包含个人工作群、AA 会话自动建群、开放群直接关联原会话、折叠回复和各工具统一 worker 等定制功能。使用本仓库版本请按下文从源码构建；公开 npm 包不保证包含这些改动。

- [完整安装配置指引](docs/INSTALL.md)：一键安装、二选一/双工具、版本检查、登录、writer/worker、后台环境及验收。
- [动态模型列表](docs/MODELS.md)：Codex、Claude、ZCode、Kilo 原生模型发现，供应商区分、刷新及删除后的处理。
- [ZCode 接入与工具扩展](docs/ZCODE.md)：本机模型账号、独立 worker、可选桌面远控配对、支持范围及架构说明。
- [Kilo 接入与使用](docs/KILO.md)：复用 VS Code 扩展运行时、动态模型及推理档位、独立 worker 和会话操作。
- [DeepSeek Harness 接入](docs/DSH.md)：官方 DSH CLI 安装、原生模型配置、独立 worker、AA 工作群、会话共享和会话操作。
- [飞书权限申请清单](docs/FEISHU_PERMISSIONS.md)：权限标识、申请用途、事件订阅与验收步骤。
- [详细配置与排错](README.zh.md)：权限模式、访问控制、会话与日志等进阶说明。
- [多服务目录说明](docs/MONOREPO.md)：飞书桥接、共享 Codex core 与独立 Web 服务的边界。
- [AI助手 A2A 接口](docs/A2A_API.md)：通过内网 HTTP 给其他 agent 委派任务，默认端口 36999，支持双别名、完整结果轮询及飞书权限确认。

## 主要功能

**会话共享**是将已有会话提供给其他群使用的能力；使用该会话的群称为**共享群**，群内提供问答与执行能力的角色称为**AI助手**。个人工作群与原生会话保持一对一绑定，共享群是该会话的额外使用入口。

- 给 Codex、Claude、ZCode 或 Kilo 会话创建个人飞书工作群，每个群对应一个会话，在群里发消息等同于ai会话中聊天。
- 一个机器人同时支持 Codex、Claude Code、ZCode、Kilo 和 DeepSeek Harness，创建工作群时选择工具与项目目录。
- 以 `AA` 开头的已有会话可自动创建同名的飞书工作群。
- 新建工作群、关联共享群时，自动为飞书 CLI 所有者开启消息免打扰；不会更改其他成员的通知设置。主 CLI 需以应用所有者登录并授权 `im:chat.user_setting:write`，不影响 Agent 专用 CLI 的身份限制。
- 把AI助手加入目标群后，由所有者在私聊选择已有会话，启用会话共享（优先选择 AA 会话）。共享群只响应真实 `@机器人` 的消息；同事可提问，回答仅回到提问群。
- 共享群默认简短回复，不提及来源会话和内部读取过程。长正文、代码和工具记录默认折叠；结束后的状态与按钮也放入折叠区。
- Codex、Claude、ZCode、Kilo 和 DSH 都通过独立 worker 执行；Codex worker 内继续使用原生队列。桥接重启后可继续同步已有结果。
- ZCode 桌面新消息每约 2 秒回推绑定的个人工作群，首次启用不补发历史；开放群和私聊群不接收桌面广播。见 [ZCode 接入说明](docs/ZCODE.md#桌面消息回推个人工作群)。

## 环境要求

| 项目      | 要求                                               |
| ------- | ------------------------------------------------ |
| Node.js | `>= 20.12.0`；本机部署已验证 Node 24                     |
| pnpm    | `10.33.0`，以 `package.json` 的 `packageManager` 为准 |
| 编程助手    | 至少配置 Codex、Claude、ZCode 或 Kilo 之一；各工具分别配置模型账号       |
| 飞书应用    | 启用机器人能力，配置权限、事件与回调，并发布应用版本                       |
| 飞书 CLI  | `lark-cli`；首次交互启动会检查安装及当前 profile 的应用绑定          |
| 部署账户    | 可读写会话状态目录，并能访问对应项目、CLI 登录信息和网络                   |

Codex 的发送、队列与选项交互依赖兼容的原生接口；桌面已有任务的问询需要可访问的公开共享 app-server，可按环境配置 `CODEX_QUEUE_REMOTE`。只安装 CLI 并不保证桌面私有连接上的交互可用。详见 [Codex 任务生命周期](docs/CODEX_TASK_LIFECYCLE.md)。

各工具独立 worker 的系统服务和重启恢复目前以 Linux 为主要验证环境。不要把桥接重启保活理解为 worker、Codex writer 或主机重启也能保活。

## 安装与首次启动

### 推荐：一键安装

先安装 Node 24（含 npm）和 Git，然后：

```bash
git clone https://github.com/cvster/feishu_ai_session.git CodexFeishu
cd CodexFeishu
bash install.sh --agents codex --install-clis
# Claude 单独使用：--agents claude；两个都用：--agents both
```

Windows 使用 `powershell -ExecutionPolicy Bypass -File .\install.ps1 --agents codex --install-clis`。脚本在用户目录准备固定 pnpm 和所选 CLI，执行依赖安装、版本/能力检查、类型检查、测试、构建；不自动登录或启动服务。Node/Git 未安装时明确提示，不通过 sudo 替换系统工具。

安装后按 [完整指引](docs/INSTALL.md) 登录、创建 profile、绑定飞书 CLI、启动所需执行服务并发布应用。检查命令：

```bash
node bin/lark-channel-bridge.mjs doctor --agents codex
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents codex --runtime --network
```

可部署任意所需工具及其 worker，也可以同时存在多个工具。桥接创建配置无需先安装 Codex。ZCode 单独安装与配置，见 [接入指引](docs/ZCODE.md)。支持基线为 Codex 0.159.2、Claude 2.1.261、飞书 CLI 1.0.97；仍须通过功能检查。后台和前台可共用 `profiles/<profile>/runtime.env`，示例见 [环境模板](config/runtime.env.example)，Linux/macOS 必须 `chmod 600`。所选工具决定检查项，不因另一工具缺失报错。

### 手动安装：下载和构建

在计划长期保留的目录安装，不要把后台服务指向 `npx` 临时缓存。

```bash
git clone https://github.com/cvster/feishu_ai_session.git CodexFeishu
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

### 3. 启动 worker 与桥接

每个使用的工具都需启动 worker。桥接自动扫描 `profiles/<profile>/workers/*/endpoint.json`，从健康接口读取工具和能力；只用 Kilo 时无需安装 Codex。配置放在对应 worker 的 `config.json`。详见 [统一接口](docs/WORKER_API.md) 和 [迁移步骤](docs/WORKER_MIGRATION.md)。

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool codex
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool codex

node bin/lark-channel-bridge.mjs run --profile my-bot
```

`run` 用于前台调试。首次启动会检查 `lark-cli`；无交互的系统服务不会自动安装缺失的 CLI，可预先运行 `npm install -g @larksuite/cli`。桥接会为 profile 绑定对应应用，agent 内的 CLI 自动使用该 profile，默认应用机器人身份。

确认日志显示机器人已连接后，私聊它发送“新建会话”。完成前台验证后按 `Ctrl-C` 退出，再启动后台服务。

## 主要用法

### 个人工作群（含 AA 会话群）

AA 会话群就是个人工作群，不作为单独的群类型。个人工作群可以从私聊控制台创建，也可以由 `AA` 前缀会话自动建群；两者适用相同的工作群功能与权限规则。本文区分个人工作群和共享群。

同一机器人、工具和数据源下，一个原生会话只能绑定一个有效个人工作群。再次建群会返回原群，即使群列表缓存缺失也不会重复创建；恢复会话时不能占用另一个个人群的会话。手动建群和自动扫描按会话串行处理。启动时，旧重复绑定保留最早建立的有效个人群；其余群关闭桥接入口，群、历史和原生会话保留。共享群、同事私聊群、API 及迁移后的旧 FF 群继续共享原会话，不占用个人群名额。

个人工作群的直接对话原样传递消息，Codex、Claude Code、ZCode 和 Kilo 均不再附加通用桥接系统提示；有引用、附件等内容时，仅补充必要上下文。开放群入口（协作群、私聊群和 A2A）每次仅附加简短 JSON，包含当前入口、发送者权限和回复要求；不再读取来源快照或维护完整/精简提示周期。旧会话历史中的提示词不会自动删除。

归档工作群时只提供一个红色“归档”按钮。归档后提示已归档，保留群、目录和会话历史；如需解散群，由用户自行在飞书中操作。已归档群的后续消息、命令和旧卡片不再响应，也不会自动创建新会话。

会话归档后，机器人会向对应的个人 AI 对话群发送一次“会话已归档。”，不向共享群广播。支持桥接中的归档操作，以及 Codex、Kilo、ZCode、DSH 明确提供归档状态的原生会话；扫描列表中缺少会话或工具暂时不可用不会触发通知。尚未发送的通知会在桥接重启后恢复。

1. 私聊机器人发送“新建会话”或“控制台”。本版私聊主要用于会话与工作群管理。
2. 在卡片中选择 **Codex**、**Claude Code**、**ZCode**、**Kilo** 或 **DeepSeek Harness**，填写工作群名和本机项目目录。
3. 创建后进入对应群提问；需要 @ 的群请真实选择并 @ 机器人。
4. 在 `/config` 中动态选择该工具的模型，点击“刷新模型”读取新增或删除后的列表。已选模型被删除时会提示重新选择，不静默换模型；大列表支持分页。
5. 在普通工作群中用 `/cd`、`/ws`、`/config` 等命令调整目录或偏好。群创建后工具固定，不会因重启或重置切换引擎。

桌面 / CLI 中正式名称以 `AA` 开头的会话会被定期发现并创建工作群，沿用原会话 ID 与工作目录。例如 Claude 可通过 `/rename AA-项目名` 设置正式名称。已绑定的会话不重复建群；同名但不同工具、数据源或 ID 的会话分别处理。

点击回复卡片中的“复制会话”，第一行显示“复制会话：”和当前工具按钮；有原生复制能力时保留历史。第二行显示“在新工具中创建会话：”和所有已安装且执行服务可用的工具，包含当前工具；无论选择哪个工具，都在同一项目目录创建全新的独立会话与工作群，不调用原生复制。Claude Code 等没有原生复制能力的工具，第一行也采用新建方式。

从第二行创建的新群会显示“当前会话从‘来源工具’复制”和“读取原会话内容”按钮。点击后才向新会话提交 `读取来源工具 '项目名/会话名' 的内容`，并提供当时最新的本机会话记录路径；不向来源会话发送消息。读取按钮随群绑定持久保存，重启后仍可使用，同一按钮重复投递由消息队列去重。复制后不会自动持续同步来源；需要共用上下文时，将开放群直接关联原会话。

### 会话共享：把AI助手加入共享群

1. 由应用所有者把机器人拉入目标群。
2. 机器人私聊所有者：选择工具，再从该工具的未归档原始会话中选择来源；不再要求先有个人工作群。排序为 AA 会话、其他已有个人工作群的会话、其余会话；同类按最近更新排序。旧 FF 历史不作为新的关联来源。
3. 在“会话共享”卡片上选择原会话，无需配置私聊开关。
4. 共享群继承所选会话的项目目录，每次真实 @ 直接续聊该原生会话，不创建或复制会话。
5. 群成员真实 `@机器人` 后提问。未 @、`@所有人` 或其他机器人消息不处理。

同一来源按 **工具 + 本地数据源 + 原生会话 ID** 区分。个人 AA 工作群、开放群、私聊群和 API 共用原会话历史；回答只投递到本次提问入口。各入口的讨论会进入同一上下文，不适合需要历史隔离的项目。

开放群、私聊群、API 和旧 FF 工作群实时跟随原 AA 工作群的模型及推理档位；修改 AA 设置后，其他入口不再用关联时的旧配置覆盖它。在旧 FF 工作群修改模型，也写入同一个 AA 设置。没有唯一原工作群时不猜测，沿用工具自己的会话设置。

Codex 原生交互追问只发到已确认的原提问群；请求尚未匹配到投递记录时先等待，不广播到 AA 群或其他关联群。API 的原生追问不投递到飞书，受限操作的所有者确认仍按 A2A 规则处理。

通知失败、旧卡片过期或桥接重启后，所有者私聊发送 `/aux`，或点击控制台“会话共享”重新选择。`/aux` 也列出已关联共享群的使用提示。

共享群保留「停止」「刷新」两个按钮：运行时在外侧，结束后与状态一起收进详情区。长回答默认收起，点“查看详细说明”展开。默认回复不超过 200 字、5 行；明确要求详情时可给完整内容。提示词约束属于软限制，不保证模型输出一定满足字数或隐私表达要求。

不再创建 FF 原生会话或 FF 个人工作群。升级时，已有开放群、私聊群、API 和旧 FF 工作群自动改为使用对应原会话；保留旧 FF 历史、现有群和 API 别名，不自动合并旧 FF 内容。迁移会先持久化旧 FF 到原会话的对应表，中断后可继续恢复，旧版部分迁移也会核验原有绑定与会话记录。迁移使旧权限确认卡失效，未完成请求不会自动重跑。已归档的原会话保持关闭，不自动恢复。

所有者在开放群真实 `@机器人 退出` 后，停止并撤销本群请求、让机器人退群并关闭本群入口。即使是最后一个关联群退出，也不归档原会话；原工作群和其他入口保留。更换关联时先退出，再重新邀请。

### 受限操作由所有者确认

AI助手遇到修改本机项目源码、外传其他源码等会话共享权限限制时，先暂停受限步骤，再发送确认卡片。群内提问会在该群真实 @ 当前飞书 CLI 绑定应用的所有者；私聊群中的确认也发在该私聊群，处理结果只回到该群。A2A API 的确认卡仍私聊所有者。

卡片列出拟执行的命令、目标/范围、原因及提问者，提供“同意执行”和“拒绝”两个按钮。只有当前应用所有者能确认，有效期 1 小时。同意后沿用当前原会话继续请求，仅对卡片中这项操作放宽会话共享的权限限制；普通后续消息重新使用受限权限。拒绝不执行，重复点击不重复执行。群已退出或归档、会话重新关联时，旧确认不能继续使用。

待确认记录与卡片标识持久化，重启后仍可确认；已知继续消息编号时可安全恢复排队，发送结果不明时不会自动重试执行。确认仍基于提示词软约束，不能代替操作系统、账号或飞书 API 的实际权限。所有者本人直接提问沿用原有权限。

### 创建私聊群

1. 同事在已完成关联的共享群中，真实 `@机器人 私聊`。
2. 机器人创建一个私有群，成员为该同事、当前飞书 CLI 绑定应用的所有者及机器人，群名为 `私聊-{原群名}`；原共享群只收到入口链接。
3. 进入新群后 `@机器人` 提问、调试，沿用共享群的权限规则、停止和刷新按钮。受限操作在私聊群中 @ 所有者确认；所有者本人发送的请求沿用正常权限。

例如，在「C系列-Agent对话」发送 `@Lennox-AI助手 私聊`，会得到「私聊-C系列-Agent对话」。同一成员对同一共享群重复请求，会返回已有私聊群；不同成员分别建群。应用所有者由运行时查询，不写死开发者姓名或 ID。私聊群再次收到“私聊”只提示直接提问，不递归建群。建群请求去重信息及绑定持久化，接口返回超时后可在保守去重窗口内用同一请求身份重试；结果长期不明时先由所有者检查，避免重复建群。

私聊群直接复用原 AA 会话和项目目录，回答及文件只发到当前提问群。**群消息隔开，原会话历史仍共享**，调试内容会进入共同上下文。原开放群退出不自动关闭私聊群；所有者可在私聊群 `@机器人 退出` 关闭该入口，不归档原会话。已有群成员不完整时，请补齐成员或让机器人退出后重建。

旧的机器人一对一私聊问答协议 `ff-dm-v1`、`/ff`、私聊开关和接入说明发布按钮已移除；旧请求会提示改用私聊群，旧待发送输入和确认不再执行。机器人一对一私聊中的控制台和 `/aux` 管理功能保留。需要让其他 agent 直接调用时，使用 [A2A 接口](docs/A2A_API.md)。

### 图片和文件

群成员可在提问时附带图片、文件或引用消息。桥接将附件下载到本机后交给 agent。

要求机器人“把脚本发到本群”时，每次请求已注入当前 `chat_id` 和文件发送指引，使用当前应用的机器人身份，不需要再向用户索要群链接。同一个原会话被多个群复用时，也以本次请求的群 ID 为准。文件成功发送后才应报告已发送。

云文档评论是按需功能：云文档评论按文档权限生效，支持的文档中 @ 机器人可在原评论线程回复；需另外配置评论权限和事件，详见权限清单。

### 常用指令

以下工作群命令用于个人工作群；共享群提供“私聊”建群、停止、刷新和所有者退出。私聊使用控制台与 `/aux`。

| 指令                                    | 用途                       |
| ------------------------------------- | ------------------------ |
| “新建会话” / “控制台”                        | 私聊创建、关联或管理会话群            |
| `/aux`                                | 私聊管理会话共享及获取共享群使用提示           |
| `/status`                             | 查看当前 profile、工具、目录与状态    |
| `/new`、`/reset`                       | 重置当前个人工作群会话              |
| `/cd /absolute/path`                  | 切换项目目录                   |
| `/ws list`、`/ws save 名称`、`/ws use 名称` | 查看、保存和切换工作空间             |
| `/resume`                             | 选择兼容的已有会话                |
| `/config`                             | 修改模型、展示、访问及 CLI 身份偏好     |
| `/stop`                               | 停止本群当前响应；共用原会话时不停止其他群的任务 |
| `/refresh`                            | 刷新已有回复状态，不重跑任务           |
| `/timeout 10`、`/timeout off`          | 设置或关闭个人工作群空闲超时           |
| `/invite group`、`/invite user @同事`    | 管理员在个人工作群开放群或用户访问        |
| `/doctor`                             | 查看诊断报告                   |
| `/help`                               | 查看帮助                     |

### 执行权限

普通 profile 的 `permissions.defaultAccess` 与 `maxAccess` 默认均为 `full`；可配置为 `workspace` 或 `read-only`。这些执行权限与飞书 OpenAPI scope 是两回事。

开放群提示词使用简短 JSON，分开保存可信的 `context` / `rules` 和 `user_input`。每次携带当前入口、发送者权限、简答和投递要求，不再包含来源文件路径、同步步骤或提示周期。JSON 不能保证阻止越狱，也不代替执行权限控制。

共享群的默认限制是：本机可运行调试、检查、测试及所需脚本和构建，可生成调试产物，但不修改项目源码；可在外部机器执行，脚本和产物可部署，其他源码及源码包不外传。应用所有者本人发送的请求依据真实 open\_id 在本次提示词中放宽限制；同事后续请求重新附加限制，不依靠姓名判断身份。

管理身份取自当前 profile 与飞书 CLI 共用应用的 `owner_id`，启动时获取、每 30 分钟刷新，不依赖固定姓名或 ID。关联通知、受限操作确认及所有者本人放权均使用该身份。

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
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool codex
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
| `profiles/<profile>/tool-bindings.json`    | 工具与原会话入口绑定             |
| `profiles/<profile>/auxiliary-groups.json` | 共享群关联和生命周期              |
| `profiles/<profile>/ff-approvals.json` | 受限操作确认、原请求上下文与恢复状态 |
| `profiles/<profile>/<tool>-native-turn-sync.json` | 原生消息回复卡片、游标与更新序号；自动导入旧状态 |
| `profiles/<profile>/<tool>-worker-replies.json` | worker 任务投递收据；Claude 沿用 `worker-replies.json` |
| `profiles/<profile>/workers/<tool>/`     | 各工具 worker 配置、端点、收据与日志   |
| `profiles/<profile>/logs/`                 | 桥接日志与 `daemon/` 服务日志    |

常见问题：

- **群里不响应**：检查应用已发布、可用范围包含用户、机器人在群内、真实 @ 和访问名单；共享群还需所有者完成关联。
- **共享群未收到关联卡片**：检查机器人进群事件，私聊发送 `/aux` 获取待办。
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
