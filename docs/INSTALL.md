# 从 GitHub 安装与完整配置

本指引适用于 `cvster/CodexFeishu`。不要用同名上游 npm 包代替本仓库构建。飞书桥接不需要 Web 子项目的 Python、nginx、数据库或前端依赖。

## 1. 选择工具和系统

Codex、Claude **至少安装一个，也可以同时存在**。一个 profile 的 `agentKind` 是默认工具；安装两个时，同一机器人创建个人工作群可分别选择 Codex 或 Claude，群创建后工具固定。`--agents both` 会检查两者；只选一个，不要求另一个存在。

| 依赖 | 本项目基线/验证版本 | 用途 |
|---|---|---|
| Node.js + npm | Node >=20.12，推荐 Node 24；本机验证 24.20.0 | 安装和运行；本脚本不会以 root 替换系统 Node |
| Git | 能正常 clone 的版本 | 获取和更新源码 |
| pnpm | 固定 10.33.0 | 锁文件安装与构建；脚本安装到用户目录，不要求 Corepack |
| Codex CLI | >=0.159.2，并通过能力检查 | Codex 用户选择；检查 queue 参数和公开 app-server |
| Claude Code | >=2.1.261，并通过能力检查 | Claude 用户选择；检查 stream-json、权限、会话名等参数 |
| 飞书 CLI | >=1.0.97 | 文件发送、profile 应用身份和后续 CLI 操作 |
| Claude worker | 本仓库自带，需独立启动 | 只使用 Codex 时不需要 |
| Codex writer | 与 CLI 兼容的常驻公开 app-server/桌面执行端 | 只使用 Claude 时不需要；历史读取进程不承担执行 |

CLI 版本号是本项目的支持基线，不是声称这些功能在上游首次出现的版本。高于基线仍要通过命令能力、认证及运行检查。账号额度、模型可用性不能靠版本或离线检查证明；首次真实任务再验收。

Linux 用户级 systemd 是完整自动后台部署的主要支持环境。macOS/Windows 的桥接后台服务已有支持，但 Claude worker 需用 `worker run` 配合自己的进程托管。Linux 容器/WSL 未启用 systemd 时也使用前台模式。

官方安装/认证参考：[Codex CLI](https://learn.chatgpt.com/docs/cli/reference)、[Codex 认证](https://learn.chatgpt.com/docs/auth)、[Claude 安装](https://code.claude.com/docs/en/setup)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[飞书 CLI](https://github.com/larksuite/cli)。

## 2. 一键安装源码与依赖

先安装 Node 24（含 npm）和 Git，然后下载到长期保留的目录：

```bash
git clone https://github.com/cvster/CodexFeishu.git
cd CodexFeishu

# 三选一；--install-clis 允许安装缺失的外部 CLI
bash install.sh --agents codex --install-clis
bash install.sh --agents claude --install-clis
bash install.sh --agents both --install-clis
```

Windows PowerShell：

```powershell
git clone https://github.com/cvster/CodexFeishu.git
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

CLI 安装和登录后，还需有兼容的队列执行 writer。可使用已经运行的公开桌面共享端点，或按当前 Codex 官方帮助管理独立 daemon：

```bash
codex app-server daemon --help
# 新机器且没有现有 writer 时，确认账号目录后启动（已有 writer 不重启）
codex app-server daemon start
codex app-server daemon version
```

按所装版本的帮助配置并启动，或在 `runtime.env` 设置 `CODEX_QUEUE_REMOTE` 指向现有公开端点。默认发现 `CODEX_HOME/app-server-control/app-server-control.sock`。不要将另一进程私有连接地址当成公开共享端点；不要为日常桥接更新停止/重启现有 writer。版本和目录必须与登录账号、历史所在目录一致。doctor 只连公开端点做握手/只读 account/read，不提交任务、不读任务列表、不启动新 writer。

### Claude

Linux：

```bash
node bin/lark-channel-bridge.mjs worker start --profile my-bot
node bin/lark-channel-bridge.mjs worker status --profile my-bot
```

macOS/Windows/无 systemd 环境，单独终端或独立进程管理器运行：

```bash
node bin/lark-channel-bridge.mjs worker run --profile my-bot
```

worker 必须与桥接使用同一 profile、飞书应用、Claude 账号目录和 OS 用户。`worker stop` 会中断其 Claude 任务；普通更新只重启桥接。这里不要求另装 Python、Redis 或队列数据库。

## 7. 配置飞书权限与发布

完整申请列表、事件和卡片回调见 [FEISHU_PERMISSIONS.md](FEISHU_PERMISSIONS.md)。必须完成：

1. 启用机器人能力；开通所需应用身份权限。
2. 订阅消息事件、机器人入群事件，以及 `card.action.trigger` 卡片回调，使用长连接。
3. 设置应用可用范围，包含自己及实际使用的同事。
4. 创建并发布版本；需要管理员审批时等待审批通过。
5. 把机器人加入测试群，FF 群由应用所有者私聊完成关联。

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

真实验收：私聊打开控制台 → 创建测试工作群 → 提问得到完整回复 → 附件读取/发送 → 停止和刷新按钮 → FF 群关联及 @ → 按需验证私聊成员入口。不要用真实工作群归档或解散来做安装测试。

前台验证后 Ctrl-C 退出，再注册桥接后台服务：

```bash
node bin/lark-channel-bridge.mjs start --profile my-bot
node bin/lark-channel-bridge.mjs status --profile my-bot
```

Linux 若需退出登录后继续运行，由管理员为部署账户开启 systemd linger。NVM、CLI 或安装目录迁移后，检查服务记录的绝对路径；从新目录重新注册，不要指向 npx 缓存。

只有新 profile、登录、执行服务及飞书配置均准备好时，才可以给安装命令加 `--configure --start`。它不会自动配置或重启 Codex writer，也不会覆盖现有 profile。

## 9. 生产产物部署与升级

源码构建：`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build`。

只部署已构建产物时，保留同一版本的 dist、bin、package.json、锁文件、workspace 清单及工作区 package.json/许可证，安装 `pnpm install --prod --frozen-lockfile`。该命令不再触发 TypeScript 构建；**它不会生成 dist**，必须先从构建阶段取得产物。缺少 dist 时 CLI 无法启动。

升级前备份构建产物和服务配置；构建成功后只重启目标桥接。不要用旧备份覆盖新的会话、收据和队列账本；不要随代码复制他人的认证、profile 状态或 `.env`。Web 服务另行部署。

## 10. 常见阻塞

| 现象 | 处理 |
|---|---|
| 没有 Node/npm/Git | 先安装 Node 24 含 npm 和 Git；脚本不以 sudo 改系统 |
| Corepack 缺失/签名问题 | 用本安装脚本，pnpm 安装到用户工具目录 |
| 安装下载失败 | 核对 npm registry、网络和代理；不要禁用 TLS 验证 |
| 版本达标但能力失败 | PATH 指向了其他 CLI/不兼容发行版；按 doctor 的具体命令修复 |
| 前台正常后台失败 | 核对 runtime.env、服务 Node 路径、CLI 路径及运行 OS 用户 |
| Claude worker 身份不匹配 | 同一 profile/app 和 CLAUDE_CONFIG_DIR，不能跨用户读取别人的 worker |
| Codex 只有历史没有执行 | 核对真实 writer、公开端点及目录；不是重装 npm 依赖能解决 |
| 飞书已连接却没事件/按钮无效 | 核对权限、消息事件、卡片回调、发布和可用范围 |
| 工具登录状态通过但推理失败 | 核对模型权限、账号额度、提供方配置和模型服务网络 |

检查源码/测试仅证明本地兼容；真实账号授权、特定模型、企业网络和每个平台的后台保活需实际验收。
