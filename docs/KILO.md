# Kilo 接入

同一个飞书机器人可同时使用 Codex、Claude Code、ZCode 和 Kilo。Kilo 使用独立 worker，复用个人工作群、AA 自动建群、FF 辅助群、私聊群、停止/复制会话按钮和 A2A 接口，不需要新增飞书权限。

## 本机准备

已验证 Kilo **7.8.8 / 7.8.12** 的原生 HTTP/SSE 协议，7.8.12 另验证了编辑器共享后端的实时事件。桥接优先使用 profile 的 `kilo.binaryPath`，其次是 `LARK_CHANNEL_KILO_BIN`；未指定时在常见 VS Code、VS Code Server 和 Insiders 扩展目录中查找 `kilocode.kilo-code-*` 的 `bin/kilo`，最后使用 PATH 中的 `kilo`。无需为已安装的 VS Code 扩展重复安装 CLI。

默认沿用 Kilo 自己的配置、认证和原生会话库。供应商凭据不会复制进桥接配置、提示词或飞书卡片。若显式配置运行时，将下面的 `kilo` 字段合入现有 profile，保留其他设置：

```json
{
  "kilo": {
    "binaryPath": "/absolute/path/to/kilo"
  }
}
```

可选 `args` 用于包装启动命令。可选 `dataHome` 对应原生 `XDG_DATA_HOME`，数据源目录为 `<dataHome>/kilo`，默认是 `$XDG_DATA_HOME/kilo` 或 `~/.local/share/kilo`。桥接和 worker 必须使用同一数据源。不要在已有群上直接切换数据源。

Linux 默认启用 `editorSync`：执行时优先连接同一 OS 用户、同一 Kilo 二进制、同一数据库且工作目录匹配的 VS Code 后端。认证从该进程的本机环境读取，仅在内存中使用，不写配置或日志。连接成功后，飞书产生的事件也会进入 VS Code 插件订阅的 `/global/event`，已打开的同一原生会话可以实时显示。其他会话可从插件历史列表打开；桥接不会强制切换当前编辑器标签。仅共享数据库、分别启动后端时，已有插件不会收到另一个进程的实时事件，这是此前未即时刷新的原因。

没有匹配的编辑器时，仍启动桥接自己的后端；不支持 `/proc` 的系统、自定义启动 `args`、其他数据库或其他工作目录不会自动连接。多个窗口都匹配同一目录时拒绝提交，请关闭重复窗口；已选编辑器健康检查失败或连接断开后不改用其他后端重发。设置 `kilo.editorSync: false` 可始终使用独立后端。

安装脚本的 CLI 自动安装仍仅支持 Codex/Claude；Kilo 请先通过官方扩展或官方 CLI 完成准备。

## 启动和使用

从源码构建后，先检查并启动 Kilo worker，再启动桥接：

```bash
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents kilo
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool kilo
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool kilo
node bin/lark-channel-bridge.mjs run --profile my-bot
```

Linux 服务名为 `lark-channel-worker.kilo.my-bot.service`。其他系统可使用 `worker run --profile my-bot --tool kilo` 并自行托管进程。新增 Kilo 只需启动其 worker 和更新桥接；不要为此重启已有 Claude/ZCode worker 或 Codex writer。修改 Kilo 执行适配器后，需要单独升级 Kilo worker。

编辑器实时同步修复也需要升级 Kilo worker。新 worker 健康接口提供 `kiloEditorSync` 标记；桥接不会向缺少该标记的旧 worker 提交新的 Kilo 请求，避免部署后仍使用旧的独立后端路径。

私聊机器人选择「新建会话」→ **Kilo** → 填写工作群名和项目目录，即可在群中继续。已有正式标题以 `AA` 开头的原生 Kilo 会话可自动建群。原生 ID 为 `ses...`，工作群绑定后不切换工具。群头像使用 Kilo 自身图标。

将机器人拉入辅助群后，所有者可选择任意未归档的原始 Kilo 会话，按 AA、其他个人工作群、其余会话排序。FF 使用 API 读取来源最新历史，写入本机私有快照；不会向来源发送问题。所有者本人权限、同事限制和受限操作确认继续使用现有 FF 规则。新建辅助会话、私聊群和 A2A 不另建权限机制。

## 模型和推理档位

`/config` 的「刷新模型」直接读取 Kilo 当前可用供应商及其模型。值保留完整的 `供应商ID/模型ID`，模型名内的斜杠不会被截断。推理档位来自该模型自己的原生 `variants`，不从其他供应商或同名模型推断；没有元数据时只提供「跟随工具默认」。

新增、删除供应商、模型和档位后，刷新即可看到变化。默认模型读取原生配置和最近选择；已有会话优先沿用其原生供应商、模型和档位。已选模型或档位失效时提示重新选择，不自动换供应商。桥接不修改 Kilo 的全局默认设置。

## 执行和会话边界

- 只连接同用户匹配进程拥有的 `127.0.0.1` 监听端口，不通过网络对外开放 Kilo 管理接口。桥接自己的后端使用随机认证密码；共享的编辑器后端仅连接，不接管生命周期。关闭连接只取消本客户端的事件订阅，绝不会终止编辑器进程。
- 共享后端的工具、MCP 和 CLI 进程环境由 VS Code 管理，不会重新注入桥接独立子进程的环境变量（包括飞书 CLI 配置目录）。需要保持独立 worker 的专用 CLI 环境时，设置 `editorSync: false`；该模式不提供插件实时刷新。两种模式均按本次请求设置 Kilo 原生会话权限，FF 提示词与所有者确认流程保持既有行为。
- 普通消息原样传递；引用和附件作为必要上下文。附件当前仅以本机文件路径提供，不宣称支持原生多模态图片输入。FF 保持完整/精简 JSON 提示周期。
- 支持流式文本、思考和工具结果。事件按原生会话和本次用户消息 ID 过滤，重复事件不重复追加。请求结果不明或连接断开时不自动重发。
- 「停止」只中断本次 Kilo 会话；「复制会话」使用原生 fork，复制历史并创建独立工作群，不回退项目文件。来源历史读取不执行任务。改名和归档调用原生元数据接口，归档保留历史，不删除会话。
- 原生权限规则按本次 profile 访问模式设置：只读禁止编辑和命令执行；工作区模式允许读取及工作区编辑，命令等操作保留原生确认；完全访问沿用原生允许模式。这些不是操作系统沙箱。FF 的业务限制仍为提示词软约束。
- 原生权限弹窗和交互问答尚未转接到飞书；遇到后停止并明确提示，不自动同意。FF 所有者确认卡与这类原生交互是不同机制。
- worker 持有执行，桥接重启只脱离观察；重连从持久化收据更新结果。worker 或主机重启不保证任务继续，状态不明的请求不自动重跑。
- 默认共享原生历史不代表支持编辑器与飞书同时写同一会话。请先结束 VS Code 中该会话的运行，再从飞书续聊；桥接内部锁不能阻止编辑器并发写入。编辑器自行发起的回复暂不镜像到飞书。

## 验证

常规测试包含协议模拟、动态模型、来源读取、停止、异常去重、权限、AA/FF、独立 worker 和 A2A。真实问答验证为可选测试，会创建并最终归档临时原生会话，使用 Kilo 已有账号：

```bash
KILO_LIVE_SMOKE=1 pnpm exec vitest run tests/integration/kilo/live.test.ts
# 原生未设置全局默认时，也可显式选择其实际模型：
KILO_LIVE_SMOKE=1 KILO_LIVE_MODEL='provider/model' pnpm exec vitest run tests/integration/kilo/live.test.ts
```

接口以本机运行时生成的 OpenAPI 为准。会话跨项目发现使用原生全局会话接口；上游协议变化时应重新验证。参考：[官方 VS Code 架构](https://kilo.ai/docs/contributing/architecture/vscode-extension)、[CLI 运行时架构](https://kilo.ai/docs/contributing/architecture/cli-runtime)。
