# 动态模型与推理档位

飞书桥接不内置具体模型名单。个人工作群在 `/config` 中选择模型，选择按已有的工具绑定保存。辅助群、AI助手私聊群和 API 跟随原个人工作群的模型与推理档位；没有唯一原工作群时，沿用工具自己的会话设置。

| 工具 | 模型来源 | 保存的模型标识 |
| --- | --- | --- |
| Codex | 当前 CLI / app-server 的 `model/list`，读取所有分页并排除隐藏项 | 原生 `model` slug |
| Claude Code | 与实际执行相同的 CLI、账号环境和项目目录；通过 SDK `initialize` 返回的 `models` | 原生 `value`，保留别名和上下文后缀 |
| ZCode | 当前桌面供应商配置，或显式指定的独立 CLI 配置，见下文 | `providerId/modelId`，同名模型按供应商区分 |

读取列表不会提交用户消息或调用模型推理。列表反映工具提供的选择，不代表该账号已实际完成该模型的推理授权验证。无需为此申请新的飞书权限。

## 使用和刷新

模型列表按机器人应用、工具、sourceId 和项目保存在 profile 的 `model-cache/`，桥接重启和部署后继续使用。桥接启动后在后台读取各 worker 模型列表，并每 30 分钟自动刷新；新发现的 worker 和已有会话项目也自动预加载。项目尚无缓存时使用同工具、同数据源的通用缓存。首次预加载尚未成功时保留默认/当前选择，仍可手动点击刷新；刷新失败保留旧缓存。

1. 在工作群打开 `/config`，选择模型并保存。`跟随工具默认模型` 始终保留。
2. 在工具中新增、删除模型后，点击“刷新模型”才读取当前列表；打开设置只使用缓存，无须修改桥接代码、重启桥接或重启 worker。
3. 模型较多时，每页显示 80 个模型，可切换模型页；当前选择仍保留为有效卡片选项。翻页只读取缓存；刷新和翻页原地更新表单并保留表单选择。

保存前和执行指定模型前都会重新校验。模型在设置卡片打开后被删除，旧卡片不能把它重新保存；已绑定模型被删除，后续请求不执行，提示通过 `/config` 重新选择，不静默换用其他模型。列表读取失败时保留原选择并显示提示；显式模型的执行暂停，用户可刷新重试或主动选择工具默认。

进行中的任务沿用本轮已经确定的模型；配置变化在后续新请求生效。仅保存其他偏好而未提交模型字段时，不改写原模型设置。

## 统一推理档位

设置页面固定显示 `low`（低）、`medium`（中）、`high`（高）、`xhigh`（很高）、`max`（最高）、`ultra`（极限），不再显示“跟随工具默认”或“读取所选模型的推理档位”按钮。

打开设置直接使用已保存的绑定档位，不读取原生会话选项。显式刷新时，仅对尚未初始化档位的已有会话，由 worker 读取当前原生设置；工具未提供当前设置时使用最近一次执行元数据。新会话初始档位为 `high`。读取失败或原工具未上报实际档位时，页面明确说明初始选择为高，不声称已读取到实际档位。

worker 在执行时根据实际供应商/模型的能力映射：优先使用同名档位；缺档时选择最接近的正向档位，同距优先较低档；原生只有 `instant/thinking` 时映射为 `thinking`。不将正向请求映射到 `none/off`。没有可调档位时不发送不受支持的参数，并显示“工具未提供可调档位”。不同工具的同名档位不保证推理预算相同。

收据和请求指纹保留用户选择，归一事件分别记录 `requestedReasoningEffort` 与实际 `reasoningEffort`。回复显示实际值，发生映射时显示例如 `ultra → max`，不会通过重试再次执行任务。

映射在 worker 公共层完成，桥接、网页、辅助群和 API 使用同一套选择。需要升级各个 worker 才能启用该能力；`capabilities.reasoningMapping` 标识支持情况。原生模型列表和能力仍通过 `/models` 动态读取，不硬编码模型名单。

## ZCode 配置来源

按以下顺序解析，每次读取当前文件，不使用一次性复制的供应商名单：

1. `workers/zcode/config.json` 的 `options.modelConfigPath`（绝对文件路径或桌面配置目录）；或 Agent CLI 参数 `--settings` 指定的配置文件。
2. 指定 worker 的 `options.dataDir` / `ZCODE_STORAGE_DIR` 时，使用该目录下的 `config.json`，保持独立 CLI 数据源隔离。
3. 默认桌面模式读取 `~/.zcode/v2`：兼容 `provider_config.json` 的供应商规则和 `config.json` 的供应商字典。两者并存时使用最近修改的一份，适应桌面升级/降级留下旧文件的情况。可显式指定正在使用的配置文件固定来源，也可指定桌面目录自动选择。
4. 无桌面配置时使用 `~/.zcode/cli/config.json`。

只使用本次选中的配置，不混合另一格式或旧 CLI 快照中的供应商，避免恢复已删除项。供应商原生 ID 与显示名分开：选择值保留 `providerId/modelId`，卡片显示“供应商 / 模型”，同名显示项追加 ID 区分。读取 `providerOrder`、供应商/模型启停状态以及实际声明的模型 ID，`modelOrder` 只用于排序，不恢复已删除模型。支持 API Key 供应商的 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 协议。ZCode 原生 OAuth 账号凭据刷新及交互转接仍属于尚未接入的能力，不通过静默批准绕过。

新会话的默认选择来自原生 `model.main`、新版桌面 `defaultModelSelection` 或供应商推荐顺序；CLI 默认只有在所选桌面配置中仍存在完全相同的供应商/模型时才能沿用。恢复已有会话且未显式选择模型时，先加载完整的当前供应商目录，再由 ZCode 恢复该会话保存的供应商、模型和档位；不会强制替换成目录第一项。原会话模型不可用时停止本次执行并提示主动选择。选择具体模型后使用其完整供应商和模型 ID，删除该模型不会触发自动替换。切换模型不会改写桌面的 UI 选择或独立 CLI 配置文件。

配置和凭据仅在本机读取。模型列表、飞书卡片和 worker 收据只包含模型标识、显示名和推理能力元数据；执行凭据通过私有 stdin 传给本次 ZCode 进程，不放入提示词、群消息或仓库。

## 扩展工具

`AgentAdapter.listModels({ cwd })` 是统一的动态发现接口，独立 worker 代理委托给对应原生 CLI。渲染层接收一次发现的安全投影，执行层在新任务提交前校验选择。模型选项携带各模型的推理档位安全投影；具体模型与原生档位名单属于工具；交互层仅使用上述固定的统一档位。

原生接口参考：[Codex model/list](https://developers.openai.com/codex/app-server/#list-models-modellist)、[Claude Agent SDK 初始化实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)、[ZCode 供应商规则](https://github.com/zai-org/ZCode/blob/main/packages/provider/src/config/rule-data-schema.ts)。兼容性以部署的工具版本实际返回值为准。
