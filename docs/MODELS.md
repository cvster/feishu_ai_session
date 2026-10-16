# 动态模型列表

飞书桥接不内置具体模型名单。个人工作群和 FF 会话在 `/config` 中选择模型，选择按已有的工具绑定保存，FF 继续使用共享 FF 会话的模型设置。

| 工具 | 模型来源 | 保存的模型标识 |
| --- | --- | --- |
| Codex | 当前 CLI / app-server 的 `model/list`，读取所有分页并排除隐藏项 | 原生 `model` slug |
| Claude Code | 与实际执行相同的 CLI、账号环境和项目目录；通过 SDK `initialize` 返回的 `models` | 原生 `value`，保留别名和上下文后缀 |
| ZCode | 当前桌面供应商配置，或显式指定的独立 CLI 配置，见下文 | `providerId/modelId`，同名模型按供应商区分 |

读取列表不会提交用户消息或调用模型推理。列表反映工具提供的选择，不代表该账号已实际完成该模型的推理授权验证。无需为此申请新的飞书权限。

## 使用和刷新

1. 在工作群打开 `/config`，选择模型并保存。`跟随工具默认模型` 始终保留。
2. 在工具中新增、删除模型后，重新打开 `/config` 或点击“刷新模型”，立即读取当前列表，无须修改桥接代码、重启桥接或重启 worker。
3. 模型较多时，每页显示 80 个模型，可切换模型页；当前选择仍保留为有效卡片选项。刷新和翻页会打开新的表单，未保存的表单改动不会带入新表单。

保存前和执行指定模型前都会重新校验。模型在设置卡片打开后被删除，旧卡片不能把它重新保存；已绑定模型被删除，后续请求不执行，提示通过 `/config` 重新选择，不静默换用其他模型。列表读取失败时保留原选择并显示提示；显式模型的执行暂停，用户可刷新重试或主动选择工具默认。

进行中的任务沿用本轮已经确定的模型；配置变化在后续新请求生效。仅保存其他偏好而未提交模型字段时，不改写原模型设置。

## ZCode 配置来源

按以下顺序解析，每次读取当前文件，不使用一次性复制的供应商名单：

1. profile 的 `zcode.modelConfigPath`（绝对路径）；或 Agent CLI 参数 `--settings` 指定的配置文件。
2. 指定 `zcode.dataDir` / `ZCODE_STORAGE_DIR` 时，使用该目录下的 `config.json`，保持独立 CLI 数据源隔离。
3. 默认桌面模式优先使用 `~/.zcode/v2/provider_config.json` 的当前供应商规则；不存在时兼容旧版桌面 `~/.zcode/v2/config.json`。
4. 无桌面配置时使用 `~/.zcode/cli/config.json`。

新版桌面规则为准，不把旧 CLI 快照中的已删除供应商重新合并回来。读取 `providerOrder`、供应商/模型启停状态以及实际声明的模型 ID，`modelOrder` 只用于排序，不恢复已删除模型。支持 API Key 供应商的 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 协议。ZCode 原生 OAuth 账号凭据刷新及交互转接仍属于尚未接入的能力，不通过静默批准绕过。

独立 CLI 的默认选择来自 `model.main`；桌面模式跟随原生供应商推荐顺序。选择具体模型后使用其完整供应商和模型 ID，删除该模型不会触发自动替换。切换模型不会改写桌面的 UI 选择或独立 CLI 配置文件。

配置和凭据仅在本机读取。模型列表、飞书卡片和 worker 收据只包含模型标识与显示名；执行凭据通过私有 stdin 传给本次 ZCode 进程，不放入提示词、群消息或仓库。

## 扩展工具

`AgentAdapter.listModels({ cwd })` 是统一的动态发现接口，独立 worker 代理委托给对应原生 CLI。渲染层接收一次发现的安全投影，执行层在新任务提交前校验选择。不要在卡片、FF、A2A 或公共运行流程中新增模型白名单。

原生接口参考：[Codex model/list](https://developers.openai.com/codex/app-server/#list-models-modellist)、[Claude Agent SDK 初始化实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)、[ZCode 供应商规则](https://github.com/zai-org/ZCode/blob/main/packages/provider/src/config/rule-data-schema.ts)。兼容性以部署的工具版本实际返回值为准。
