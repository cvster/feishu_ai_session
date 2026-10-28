# 从 GitHub 安装与完整配置

本指引适用于 [`cvster/feishu_ai_session`](https://github.com/cvster/feishu_ai_session)。不要用同名上游 npm 包代替本仓库构建。飞书桥接不需要 Web 子项目的 Python、nginx、数据库或前端依赖。

## 最短安装路线（Linux）

推荐直接在有项目代码和工具登录信息的机器上，以日常使用工具的 OS 用户部署。无需 Docker、Redis 或数据库；桥接内置轻量网页，与桥接同进程。`apps/web-app` 是另一套独立网页，不是安装本项目的前置依赖。

1. 安装 Node 24（含 npm）和 Git，执行第 2 节的安装命令。只安装实际用的工具；Codex/Claude 可由脚本补装，Kilo/Zcode/Dsh 按各自接入文档配置。
2. 登录所选工具，按第 4 节创建 profile 并运行 `setup`；完成第 7 节飞书权限、事件和应用发布。
3. 启动所选 worker；Codex 先安装最新版桌面 App，只保留桌面 App 的 app-server 作为执行端，让 CLI、VS Code 插件及 Codex worker 全部连接它，具体见第 6 节。
4. 前台运行桥接验证真实收发，再切换后台。以下以 Codex 为例；Claude 把 `--tool codex` 和 `--agents codex` 换为 `claude`：

   ```bash
   node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool codex
   node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool codex
   node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents codex --runtime --network
   node bin/lark-channel-bridge.mjs run --profile my-bot
   # 验证后 Ctrl-C 退出前台桥接，再启动后台
   node bin/lark-channel-bridge.mjs start --profile my-bot
   node bin/lark-channel-bridge.mjs status --profile my-bot
   ```

5. 如需网页，执行 `node bin/lark-channel-bridge.mjs web configure --profile my-bot`，按提示设置监听地址、端口和认证，然后 `node bin/lark-channel-bridge.mjs restart --profile my-bot`。只重启桥接，worker 保持运行；不需要单独安装前端依赖。具体访问控制见 [网页说明](BRIDGE_WEB_PLAN.md)。

服务关系：飞书/内置网页 → 桥接 → 所选工具 worker → 原生工具；Codex worker 再连接真正持有会话的共享 writer。桥接自动发现 `workers/*/endpoint.json`，但不会因发现文件就启动 worker。下面各节用于解释首次登录、飞书发布及故障排查，不能用构建成功代替收发验收。

## 1. 选择工具和系统

安装实际使用的工具即可：Codex、Claude、Kilo、ZCode 或 DSH。只用 Kilo 无需安装 Codex。一个 profile 的 `agentKind` 是默认工具；安装两个时，同一机器人创建个人工作群可分别选择 Codex 或 Claude，群创建后工具固定。`--agents both` 会检查两者；只选一个，不要求另一个存在。

| 依赖 | 本项目基线/验证版本 | 用途 |
|---|---|---|
| Node.js + npm | Node >=20.12，推荐 Node 24；本机验证 24.20.0 | 安装和运行；本脚本不会以 root 替换系统 Node |
| Git | 能正常 clone 的版本 | 获取和更新源码 |
| pnpm | 固定 10.33.0 | 锁文件安装与构建；脚本安装到用户目录，不要求 Corepack |
| Codex CLI | >=0.159.2，并通过能力检查 | Codex 用户选择；检查 queue 参数和公开 app-server |
| Claude Code | >=2.1.261，并通过能力检查 | Claude 用户选择；检查 stream-json、权限、会话名等参数 |
| 飞书 CLI | >=1.0.97 | 文件发送、profile 应用身份和后续 CLI 操作 |
| 工具 worker | 本仓库自带，按工具独立启动 | 所有工具包含 Codex 都通过 worker 接入 |
| Codex writer | 最新版 Codex 桌面 App 的共享 app-server | CLI、VS Code 插件和 worker 共用此执行端；只使用 Claude 时不需要 |

CLI 版本号是本项目的支持基线，不是声称这些功能在上游首次出现的版本。高于基线仍要通过命令能力、认证及运行检查。账号额度、模型可用性不能靠版本或离线检查证明；首次真实任务再验收。

Linux 用户级 systemd 是完整自动后台部署的主要支持环境。macOS/Windows 的桥接后台服务已有支持，但工具 worker 需用 `worker run` 配合自己的进程托管。Linux 容器/WSL 未启用 systemd 时也使用前台模式。

官方安装/认证参考：[Codex CLI](https://learn.chatgpt.com/docs/cli/reference)、[Codex 认证](https://learn.chatgpt.com/docs/auth)、[Claude 安装](https://code.claude.com/docs/en/setup)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[飞书 CLI](https://github.com/larksuite/cli)。

## 2. 一键安装源码与依赖

先安装 Node 24（含 npm）和 Git，然后下载到长期保留的目录：

```bash
git clone https://github.com/cvster/feishu_ai_session.git CodexFeishu
cd CodexFeishu

# 三选一；--install-clis 允许安装缺失的外部 CLI
bash install.sh --agents codex --install-clis
bash install.sh --agents claude --install-clis
bash install.sh --agents both --install-clis
```

Windows PowerShell：

```powershell
git clone https://github.com/cvster/feishu_ai_session.git CodexFeishu
cd CodexFeishu
powershell -ExecutionPolicy Bypass -File .\install.ps1 --agents both --install-clis
```

也可在任何支持的平台直接运行 `node tools/install.mjs --agents codex --install-clis`。不加 `--install-clis` 时只使用已安装的外部 CLI；`--agents auto` 检测已有工具，两个都没有时要求明确选择。现有 CLI 不会被覆盖；加 `--install-clis` 时，缺失或低于基线的 CLI 会在用户工具目录补装固定版本，并优先使用该目录，不降级已经满足要求的版本。不会改绑其他飞书应用、覆盖 profile、登录账号、启动模型任务或重启已有服务。

脚本把 pnpm 和缺失的 CLI 安装到 `~/.local/share/codexfeishu-tools`，避免 sudo/全局 npm 权限；可用 `CODEXFEISHU_TOOLS_DIR` 改目录。脚本自动设置当次 PATH。以后手动操作需将 `<工具目录>/node_modules/.bin` 加入 PATH；原生 Claude 通常位于 `~/.local/bin`。Windows 将对应目录加入用户 PATH。设置当前终端 PATH 的示例：

```bash
export PATH="$HOME/.local/share/codexfeishu-tools/node_modules/.bin:$HOME/.local/bin:$PATH"
```

```powershell
$env:Path = "$HOME\.local\share\codexfeishu-tools\node_modules\.bin;$HOME\.local\bin;$env:Path"
```

原生/公司管理的 CLI 可自行安装后不使用 `--install-clis`。Claude 的原生安装是上游推荐方式，脚本使用仍可选的 npm 安装方式以便固定验证版本。

脚本依次执行固定 pnpm 安装、冻结锁文件依赖安装、CLI 检查、类型检查、测试和构建；默认不会跳过测试。`--skip-tests` 仅适合已经验证过的环境。安装中断后可重新运行，不自动执行 `git pull` 或覆盖用户代码。

安装阶段未登录或未创建 profile 显示警告，不假报运行成功。缺依赖、版本过旧、能力不匹配会非零退出并给出修复建议。

## 3. 登录选中的编程助手

以未来运行服务的同一个 OS 用户登录，避免“root 装好了、普通用户服务没登录”：

```bash
# 只使用 Codex 的人
codex login
codex login status

# 只使用 Claude 的人
claude auth login
claude auth status --json
```

两者都用则分别登录。自定义提供方/企业账号按各自官方文档配置，环境变量放入下一节的本地 `runtime.env`；不要把 API key 写到项目仓库、命令历史或发给别人。认证状态命令通过不代表模型授权、额度和网络推理一定可用。

## 4. 创建 profile 和机器人

```bash
# --agent 选择默认工具；两个都装了时另一工具仍可在工作群创建卡片中选择
node bin/lark-channel-bridge.mjs profile create my-bot \
  --agent codex --workspace /absolute/path/to/project
node bin/lark-channel-bridge.mjs profile use my-bot
node bin/lark-channel-bridge.mjs setup --profile my-bot
```

仅 Claude 时换成 `--agent claude`。扫码创建应用，或加 `--app-id cli_xxx` 并在交互提示中输入 Secret；Lark 国际版加 `--tenant lark`。现有 profile 不能通过重复创建覆盖。

也可以把新 profile 初始化合并进安装脚本：

```bash
bash install.sh --agents both --install-clis --configure \
  --profile my-bot --workspace /absolute/path/to/project
```

该过程仍需人工扫码/输入凭据，不能替代飞书审批与发布。

### Kilo 接入

Kilo 支持 VS Code 插件和独立 CLI。Kilo App/Desktop 已移除，旧 `preferredClient`
设置不再使用；旧 App 会话保留历史但不会列出或续聊。原生配置位于
`profiles/<profile>/workers/kilo/config.json`。完整说明见 [Kilo](KILO.md)。

## 5. 统一前台和后台环境

复制 [环境模板](../config/runtime.env.example) 到：

```text
~/.lark-channel/profiles/my-bot/runtime.env
```

Linux/macOS 执行 `chmod 600`，Windows 限制到当前用户可读写。文件权限过宽会拒绝读取，以免泄露凭据。桥接、worker 和 doctor 使用同一份文件，文件中的值优先于继承的终端环境。修改后对相应服务生效需要重新启动该服务；不要把 worker 的重启混入日常桥接更新。

采用 `KEY='字面值'`，**不执行 shell、不展开 `$HOME`**，路径使用绝对路径。禁止设置 HOME、USERPROFILE、LARK_CHANNEL_HOME、NODE_OPTIONS。数据根目录由启动环境中的 `LARK_CHANNEL_HOME` 决定，不能在其内部文件里再次修改。

重点核对：`CODEX_HOME`、`CODEX_QUEUE_REMOTE`、`CLAUDE_CONFIG_DIR`、两个 CLI 的自定义路径、PATH 及模型提供方/代理设置。只写需要的项；不要复制本仓库维护者的用户目录或账号。

飞书 HTTP/WebSocket 默认直连；公司网络需要代理时，在 runtime.env 同时设置 `LARK_CHANNEL_FEISHU_USE_PROXY=1` 和相应 HTTP_PROXY/HTTPS_PROXY。该开关只显式启用飞书 SDK 的代理支持；不设置时保留原有直连行为。代理是否兼容 WebSocket 仍需前台连接验收，不能用一次 HTTP 成功代替。

## 6. 启动所需执行服务

### Codex

推荐安装并登录 **最新版 Codex 桌面 App**，只保留桌面 App 的 app-server 作为会话执行端；其他所有入口，包括 Codex CLI、VS Code 插件及 Codex worker，都使用这个 app-server。更新各客户端至支持共享连接的版本，并配置为连接桌面 App 实际提供的共享端点。

桌面 App 启动后，在 `runtime.env` 中设置 `CODEX_QUEUE_REMOTE` 指向该端点，具体示例见下文。默认发现位置为 `CODEX_HOME/app-server-control/app-server-control.sock`，但必须确认它属于桌面正在使用的实例。CLI 和 VS Code 插件按各自版本支持的共享连接配置使用同一端点；`CODEX_QUEUE_REMOTE` 是本桥接 worker 的配置，不会自动替其他客户端完成配置。

迁移时先正常结束其他独立执行端上的任务，再停用它们的 app-server/daemon 及自动启动配置，保留桌面 App 的执行端。不要另起独立 daemon，也不要在日常桥接更新中停止或重启桌面 app-server。历史读取进程不承担执行，不能用它恢复或修改会话。doctor 只连公开端点做握手/只读 account/read，不提交任务、不读任务列表、不启动新 writer。

#### 提示“另一个 writer 占用”怎么办

**现象：** 恢复会话、改模型/推理档位或提交消息失败，原生错误提到 `writer`、`another writer` 或会话已被其他执行端持有（不同 Codex 版本措辞可能不同）；也可能表现为历史能读、提交失败，或飞书执行结果与桌面实时状态不一致。

**原因：** 同一会话的执行所有权在另一个 app-server/客户端中，当前连接尝试恢复或修改它。桌面 App、独立 CLI、另起的 daemon 可能不是同一个 writer。账号、`CODEX_HOME` 和历史文件相同，并不等于共享运行实例。不要把多个 app-server 进程本身视为故障：只读历史进程可以正常存在，关键是写操作连接哪个实例。

**推荐处理：**

1. **安装最新版 Codex 桌面 App，只保留桌面 App 的 app-server。** 正常结束其他独立执行端上的任务后，停用 CLI、VS Code 插件或独立 daemon 另起的执行服务及其自动启动配置，避免再次竞争同一会话。保留会话历史和运行数据。
2. **所有工具共用桌面 app-server。** 将 CLI、VS Code 插件、Codex worker 及其他会话客户端都配置为连接桌面实际提供的共享端点。worker 按下节配置 `CODEX_QUEUE_REMOTE`，其他客户端按其支持的配置接入；核对 CLI 路径、运行用户和 `CODEX_HOME`。消息提交、模型设置、停止及交互都走同一个 writer，不能通过独立 reader 的 `thread/resume` 强行抢占。
3. **如果改的是 worker 的环境、CLI 路径或配置，需要单独重新启动 Codex worker 才能加载。** 仅重启桥接不会刷新正在运行的 worker 环境。在自己安排的维护窗口执行：

   ```bash
   node bin/lark-channel-bridge.mjs worker stop --profile my-bot --tool codex
   node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool codex
   node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool codex
   node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents codex --runtime --network
   ```

   worker 停止可能中断其任务，不能作为普通桥接部署的固定步骤。以上命令不停止桌面或共享 writer。
4. 某个客户端不支持共享连接时，先更新到支持的版本并完成配置，再用它操作原会话。不要为绕过连接问题重新启动独立 writer，或删除 socket、锁文件、SQLite、会话历史、提交收据和队列账本。
5. 恢复后先检查原消息有没有被接收/执行，再重试未执行的请求，避免重复任务。在专用测试会话验证群与桌面双向消息、停止和交互；doctor 连接通过不能独自证明桌面共用 writer。

此处是本项目队列实现的排错说明。公开协议与传输以 [OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 和安装版本的 `--help` 为准；官方通用 app-server 文档并未保证每个桌面版本都开放相同的共享 writer 接入方式。

#### 旧版 CLI 与桌面 App 未共用 app-server

部分旧版 Codex CLI 与桌面 App 会各自启动 app-server；PATH 指向旧 CLI、后台服务使用另一份可执行文件，或另起独立 daemon，也可能出现同样的情况。**同一账号、相同 `CODEX_HOME`、能读取同一份历史，不代表共用同一个运行中的 app-server。** 这类问题不是飞书权限或 AA 群绑定错误。

常见现象：飞书输入已执行，但桌面会话不实时刷新，重新打开后才看到历史；桌面正在执行，桥接却显示找不到活跃轮次、停止按钮无法停止桌面任务，或桌面交互问题无法在飞书回答。若旧 CLI 不支持所需队列/共享连接能力，也可能直接提交失败。单独启动一个 daemon 并不保证桌面会连接它。

按以下顺序核对桌面 App 与所有客户端是否已共用执行端：

1. **确认真正使用的 CLI。** 终端执行下面的只读检查，同时核对 `workers/codex/config.json` 的 `options.binaryPath`、worker 服务 PATH 和运行 OS 用户。Windows 用 `where.exe codex`，不要只看当前终端能运行哪个版本。

   ```bash
   command -v codex
   codex --version
   codex queue --help
   codex app-server daemon version
   ```

   `queue --help` 应提供 `--remote`；不认识命令或参数时，先更新 CLI 至本文支持基线并重新做能力检查。`daemon version` 中的 `cliVersion`、`appServerVersion`、`socketPath` 可辅助判断版本与连接来源；这份输出本身不能证明桌面使用同一实例。

2. **统一安装来源与账号目录。** 将 Codex worker 的 `options.binaryPath` 指向已验证兼容的 CLI 的绝对路径；桌面与 worker 使用相同账号和预期的 `CODEX_HOME`。升级 CLI 后检查后台仍引用的旧路径。不同版本号不一定有问题，最终以协议能力和实际连接为准。

3. **将所有客户端连接到桌面 app-server。** 在最新版桌面 App 中按该版本支持的方式启用共享连接；CLI、VS Code 插件按各自配置连接同一端点，Codex worker 在 profile 的 `runtime.env` 中指定，例如：

   ```text
   CODEX_HOME='/absolute/path/to/.codex'
   CODEX_QUEUE_REMOTE='unix:///absolute/path/to/.codex/app-server-control/app-server-control.sock'
   ```

   路径须替换为本机真实值；仅当该 socket 确实属于桌面使用的共享 writer 时，这个配置才解决运行时不同步。端点格式见 [官方 app-server 传输说明](https://learn.chatgpt.com/docs/app-server)。若旧桌面只提供自己的私有连接，先升级到兼容版本并按该版本支持的共享方式配置；不能只靠修改桥接端点强行接入私有连接，也不要猜测桌面启动参数。其他客户端也必须实际连接该端点，不能只统一账号和历史目录。

4. **加载配置并验收。** 如果修改了 worker 的环境或 CLI 路径，按上节在维护窗口单独重新启动 Codex worker；只改桥接配置时仅重启桥接。然后执行 `node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents codex --runtime --network` 检查公开端点，再在同一个个人工作群和桌面会话分别发送一条测试消息，确认双向显示、停止与交互都作用于同一会话。doctor 通过只证明连接与认证，不证明桌面已共用该实例。确需升级/重启桌面或 writer 时，另行安排维护；日常桥接部署不要连带重启它们，也不要删除会话、队列或回复账本来修复连接问题。

桌面 App 的共享 app-server 准备好后，还必须启动 **Codex worker**（worker 是连接它的适配服务，不是另一个执行 writer）：

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool codex
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool codex
```

macOS/Windows/无 systemd 环境使用 `worker run --profile my-bot --tool codex`，交给自己的进程管理器托管。

### Claude

Linux：

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool claude
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool claude
```

macOS/Windows/无 systemd 环境，单独终端或独立进程管理器运行：

```bash
node bin/lark-channel-bridge.mjs worker run --profile my-bot --tool claude
```

worker 必须与桥接使用同一 profile、飞书应用、Claude 账号目录和 OS 用户。`worker stop` 会中断其 Claude 任务；普通更新只重启桥接。这里不要求另装 Python、Redis 或队列数据库。

### ZCode（可选）

ZCode 需单独安装；上述安装脚本不会安装它。按 [ZCode 安装与配对指引](ZCODE.md) 配置原生 Agent CLI、账号和项目目录。只使用 ZCode 的新安装，第 4 节创建 profile 时使用 `--agent zcode`；已有 profile 保留原默认工具。

如需飞书输入在 ZCode 桌面实时显示，先在桌面开启“移动端远程控制”，再按该指引通过 stdin 导入配对链接。独立 CLI 执行与桌面实时同步是两种模式，仅读取同一历史数据库不会启用实时同步。配对后启动 ZCode 专用 worker，再启动桥接；已有 worker 则按指引单独停止、启动以加载配置。远控模式需要桌面保持运行、登录并打开对应本地项目，通信经过 ZCode 官方中继。

## 7. 配置飞书权限与发布

完整申请列表、事件和卡片回调见 [FEISHU_PERMISSIONS.md](FEISHU_PERMISSIONS.md)。必须完成：

1. 启用机器人能力；开通所需应用身份权限。个人 AI 群无需 @ 必须开通 `im:message.group_msg`；只开通群 @ 消息权限时，飞书不会推送普通群消息。完整清单见 [权限指引](FEISHU_PERMISSIONS.md)。
2. 订阅消息事件、机器人入群事件，以及 `card.action.trigger` 卡片回调，使用长连接。
3. 设置应用可用范围，包含自己及实际使用的同事。
4. 创建并发布版本；需要管理员审批时等待审批通过。
5. 把机器人加入测试群，辅助群由应用所有者私聊启用会话共享。

应用身份权限与个人用户授权不是一回事。scope 申请成功也不代表事件订阅、应用发布和可用范围已经正确。

## 8. 分阶段检查与启动

```bash
# 安装检查：缺失 CLI/依赖会失败；未登录/未初始化是警告
node bin/lark-channel-bridge.mjs doctor --agents both

# 运行检查：认证、profile、目录、所选 writer/worker 必须通过
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents both --runtime --network

# 机器可读报告，不输出凭据值
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents both --runtime --json

# 首次先前台核验 CLI 绑定和真实收发
node bin/lark-channel-bridge.mjs run --profile my-bot
```

只用一个工具时将 both 换成 codex/claude。缺省 auto 有 profile 时仅检查默认工具，想验证两者请明确写 both。`--network` 额外按配置检查飞书网络、应用凭据及所有者读取；不发消息、不加群、不改权限。依赖与能力检查不会运行模型推理。诊断不会通过打印登录命令原文、服务环境、App Secret 或 token 泄露凭据。

真实验收：私聊打开控制台 → 创建测试工作群 → 提问得到完整回复 → 附件读取/发送 → 停止和刷新按钮 → 会话共享设置及辅助群 @ 提问 → 按需验证私聊成员入口。不要用真实工作群归档或解散来做安装测试。

前台验证后 Ctrl-C 退出，再注册桥接后台服务：

```bash
node bin/lark-channel-bridge.mjs start --profile my-bot
node bin/lark-channel-bridge.mjs status --profile my-bot
```

Linux 若需退出登录后继续运行，由管理员为部署账户开启 systemd linger。NVM、CLI 或安装目录迁移后，检查服务记录的绝对路径；从新目录重新注册，不要指向 npx 缓存。

只有新 profile、登录、执行服务及飞书配置均准备好时，才可以给安装命令加 `--configure --start`。它会在 Linux 启动所选 Codex/Claude worker，再检查并启动桥接；不会自动配置或重启 Codex writer，也不会覆盖现有 profile。

## 9. 生产产物部署与升级

源码构建：`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build`。

只部署已构建产物时，保留同一版本的 dist、bin、package.json、锁文件、workspace 清单及工作区 package.json/许可证，安装 `pnpm install --prod --frozen-lockfile`。该命令不再触发 TypeScript 构建；**它不会生成 dist**，必须先从构建阶段取得产物。缺少 dist 时 CLI 无法启动。

升级前备份构建产物和服务配置；构建成功后只重启目标桥接。不要用旧备份覆盖新的会话、收据和队列账本；不要随代码复制他人的认证、profile 状态或 `.env`。桥接内置网页随桥接一起部署；独立 `apps/web-app` 才需另行部署。

新增工具时，更新桥接并为新工具启动自己的 worker；已有 worker 与 Codex writer 不随桥接重启，已接收任务继续运行。桥接重连期间回复同步可能短暂停顿，恢复后读取原收据；不要重发任务或重建执行队列。

运行中的 worker 保持已加载的代码。只更新磁盘产物不会使其自动支持新执行能力；涉及原生参数或执行协议变化时，单独安排对应 worker 升级，重启该 worker 会中断其任务。新桥接通过 `capabilities.reasoningMapping` 识别统一推理档位映射支持；涉及统一档位的请求需要新 worker。worker 根据原生模型能力映射档位，并在回复中记录实际值。此检查不会重启任何服务。

部署产物、依赖或 Node/CLI 路径变更仍可能影响旧进程后续启动子进程或延迟加载文件。每个版本放在独立目录，保留旧目录及其依赖；避免原地删除旧 worker 使用的文件。

### 已有 profile 一键部署（Linux 用户 systemd）

以运行桥接的同一个 OS 用户，在源码仓库中运行。首次安装、工具登录、飞书发布和服务创建先按前面的章节完成；升级不再次运行 `setup` 或 `web configure`。

```bash
# 只读预检；不安装、不构建、不重启
node tools/deploy.mjs --profile my-bot --check

# 一键升级：准备 pnpm → 冻结依赖 → 类型检查 → 构建 → 部署 → 健康检查
node tools/deploy.mjs --profile my-bot

# 查看帮助不要求已安装依赖或存在服务
node tools/deploy.mjs --help

# 对应 pnpm 简写；旧的 deploy:local 入口仍可用
pnpm deploy --profile my-bot

# worker 代码确有变化时才单独安排更新
node tools/deploy.mjs --profile my-bot --workers codex

# 使用脚本打印的旧版本号回退
node tools/deploy.mjs --profile my-bot --rollback <旧版本号>
```

Node >=20.12（推荐 24）、npm、Git 和 tar 需已安装，用户 systemd 需可访问。脚本与安装器共用用户目录里的固定版本 pnpm，自动补装，不要求全局 pnpm、Corepack 或 sudo。`--check` 会显示部署目录、服务名及工作区是否干净，缺少服务时提示先 `start`。首次在仓库构建前自动安装开发依赖；默认执行类型检查，修改代码后的测试按 [测试指引](TESTING.md) 运行。同一 Git 版本再次部署复用完整的不可变版本目录，支持重试，不要求删除旧版本。`--skip-build` 仅用于本地构建已经验证的场景；`--no-restart` 只切换磁盘版本，运行中的服务仍使用旧代码。

部署不修改 profile 的应用凭据、worker 配置、`runtime.env`、会话关联、网页密码/Token 和未过期的网页登录状态。密码仍是原密码，Token 仍是原 Token；只有主动重新配置/轮换才更改。网页登录保留原有 12 小时有效期，不因部署续期。

脚本要求工作区干净，在仓库安装冻结依赖、类型检查并构建 `HEAD` 后以 `git archive` 加构建产物生成 `releases/<sha>`；锁文件未变时复用当前版本的生产依赖，否则执行 `pnpm install --prod --frozen-lockfile`。随后原子切换 `current` 链接，并把该 profile 的桥接和 worker 服务入口统一改为 `current/bin/lark-channel-bridge.mjs`（原单元文件备份到 `deployment-backups/`）。Node 按真实路径加载模块，运行中的进程继续使用启动时的版本目录；未列入 `--workers` 的 worker 不重启，仅在之后自行重启时加载 `current`。指定的 worker 先重启并确认 `/health`，再重启桥接，最后检查网页和所有 worker 的 `/health`，结果写入版本目录的 `deployment.json`。脚本不会启停 Codex Desktop、共享 app-server 或其他进程。默认部署根目录 `~/lark-coding-agent-bridge`，可用 `--root` 或 `LARK_BRIDGE_DEPLOY_ROOT` 指定。

在通过 worker 会话内（例如飞书群里）执行部署时，脚本自身运行在即将被重启的服务单元里，重启会连带杀掉脚本。此时脚本先把重启计划和校验清单写入 `deployment-backups/<stamp>-<sha>/plan.json`，再用 `systemd-run --user` 启动一个独立的一次性单元接管全部重启与校验，然后自行退出；父会话可断开，用 `journalctl --user -u lark-bridge-deploy-*` 查看进度。因此该场景下当前 worker 会话结束属正常现象，`deployment.json` 由接管单元写入。脚本打印的 `rollback:` 行按 `previous-current` 生成，可直接用于回退。


## 10. 常见阻塞

| 现象 | 处理 |
|---|---|
| 没有 Node/npm/Git | 先安装 Node 24 含 npm 和 Git；脚本不以 sudo 改系统 |
| Corepack 缺失/签名问题 | 用本安装脚本，pnpm 安装到用户工具目录 |
| 安装下载失败 | 核对 npm registry、网络和代理；不要禁用 TLS 验证 |
| 版本达标但能力失败 | PATH 指向了其他 CLI/不兼容发行版；按 doctor 的具体命令修复 |
| 前台正常后台失败 | 核对 runtime.env、服务 Node 路径、CLI 路径及运行 OS 用户 |
| Claude worker 身份不匹配 | 同一 profile/app 和 CLAUDE_CONFIG_DIR，不能跨用户读取别人的 worker |
| Codex 提示另一个 writer 占用 | 按第 6 节安装最新版桌面 App，所有客户端共用桌面 app-server；保留历史与账本 |
| Claude 提示该会话正在另一个进程运行 | 该 session ID 已由原终端占用；在原终端结束该会话后再重发。同目录的其他会话不再拦截，见下文 |
| Codex 只有历史没有执行 | 核对真实 writer、公开端点及目录；不是重装 npm 依赖能解决 |
| 飞书能执行但 Codex 桌面不刷新，停止/交互无法作用于桌面任务 | 排查旧 CLI 或不同 app-server；见第 6 节“旧版 CLI 与桌面 App 未共用 app-server” |
| 飞书已连接却没事件/按钮无效 | 核对权限、消息事件、卡片回调、发布和可用范围 |
| 工具登录状态通过但推理失败 | 核对模型权限、账号额度、提供方配置和模型服务网络 |

检查源码/测试仅证明本地兼容；真实账号授权、特定模型、企业网络和每个平台的后台保活需实际验收。

所有工具需独立 worker，例如 `worker start --profile my-bot --tool codex` 或 `--tool kilo`。桥接自动扫描 `workers/*/endpoint.json`，无需工具专用桥接配置。旧部署升级请先阅读 [完整迁移步骤](WORKER_MIGRATION.md)。

### Claude 会话占用与 Codex writer 占用的区别

`该会话正在另一个 Claude Code 进程中运行，请先在原终端结束该会话，再从群内继续。` 是本项目的保护检查，表示这次请求被拒绝，尚未执行。恢复已有 Claude 会话前，Linux worker 只读列出同 OS 用户、同工作目录的 Claude 进程，再逐个确定它们当前持有的 session ID，**只拒绝与目标 session ID 相同的进程**。同一目录下的其他会话互不影响：Claude Code 本身支持一个目录并发多个会话，真正会互相破坏的是两个进程读写同一份会话记录和 `~/.claude/tasks/<sessionId>/`。

现有进程的 session ID 依次取 `claude agents --json` 的实时列表（能反映进程内 `/resume` 切换）、启动参数中的 `--resume`/`-r`/`--session-id`、以及 CLI 启动时写下的 `~/.claude/sessions/<pid>.json`（校验 pid 与 `procStart`，避免 pid 复用误判）。目录下没有其他 Claude 进程时直接返回空闲，不产生子进程调用；worker 自己拉起的子进程和专用不保存会话的模型列表查询都不计入。若某个进程的 session ID 无法确定（例如旧版 CLI 且进程内切换过会话），仍按保守策略拒绝并提示“无法确认原 Claude 会话是否被占用”。

在对应原终端正常退出该会话，或对同一会话改用新的会话（`--fork-session` 复制历史到新 ID）后，再从群里发送未执行的消息。不要仅因为收到提示就强杀所有 Claude 进程。该检查不能防止外部终端在检查后启动同一会话，非 Linux 或无法读取进程信息时同样报“无法确认”。它与 Codex app-server 的 writer 所有权冲突是两套机制。
