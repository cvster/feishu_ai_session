# 项目助手 A2A 接口

将开放群关联的原 AA 会话作为项目助手提供给同事或其他 agent。第一版采用 [A2A 1.0 HTTP+JSON](https://a2a-protocol.org/v1.0.0/specification/)，支持纯文本任务、异步提交、完整结果轮询、取消、任务列表和 Agent Card。暂不提供 MCP、模型供应商接口、流式事件、Webhook、文件输入或在旧 task 上提交新消息。

这是有共享历史和执行能力的项目助手，不要把地址填进 agent 的“模型供应商 / OpenAI base_url”。调用方只在需要项目问答或调试检查时委派一个明确任务，不提交完整聊天历史、系统提示词或工具循环。第一版为有限范围的协议实现，尚未宣称通过 A2A 全量一致性认证。

## 地址与别名

默认端口 **36999**，仅监听明确配置的本机 `10.88` IPv4 地址，不监听 `0.0.0.0` 或其他网卡。用户名命名空间由部署者配置并固定，不从飞书昵称动态生成，不写死为项目开发者姓名。

```text
http://10.88.80.121:36999/LennoxGao/agents/session-<UUID>
http://10.88.80.121:36999/LennoxGao/agents/c-series
```

以上用户名、IP 和易读别名只是配置示例。永久别名 `session-<UUID>` 对应现有入口的 `aux_<UUID>`；从 FF 迁移到原会话时继续保留。可选易读别名与永久别名同时有效，共用会话、队列和鉴权。会话标题、群名变化不改变别名；修改易读别名后旧易读别名停用且不分配给其他会话，永久别名不变。Agent Card 发布永久地址。

同一原会话关联多个开放群时共用入口。原 AA 工作群、开放群、私聊群与 API 共用原会话上下文，不创建 FF 会话。调用者只能查询自己密钥所提交任务的输入和结果，不能下载整个原会话历史，但模型回答仍可能利用共享历史；不要把互不信任的项目放在同一原会话中。

API 请求实时跟随原 AA 工作群的模型和推理档位，不复用旧 FF 的模型副本。原生交互追问不广播到任何飞书群；受限操作确认卡仍只私聊所有者。迁移先保存旧新会话映射，中断后重启可继续恢复，现有 URL 和别名不变。

## 管理与启用

先从源码构建，在实际运行桥接的目录执行。下面 `my-bot` 替换为目标 profile；可给每条命令增加 `--config /absolute/path/config.json`。

```bash
# 选取唯一的本机 10.88 地址；多个匹配时必须指定 --host。
node bin/lark-channel-bridge.mjs a2a configure --profile my-bot \
  --namespace LennoxGao --port 36999

# 查看内部 ID、永久别名、易读别名和密钥摘要，不输出密钥。
node bin/lark-channel-bridge.mjs a2a list --profile my-bot

# 用 list 中的完整永久别名替换占位符。
node bin/lark-channel-bridge.mjs a2a enable 'session-<UUID>' \
  --alias c-series --profile my-bot

# 每位同事/agent 一把普通密钥；明文仅在本次输出中显示。
node bin/lark-channel-bridge.mjs a2a grant c-series \
  --name colleague-agent --profile my-bot
```

配置监听后按现有部署流程重启桥接，才会开始监听。管理命令本身不会部署或重启服务；未配置时默认不监听。已经监听后，启停单个入口、修改别名、签发/撤销密钥无需重启。更改 host/port 需要重启，在此之前旧监听拒绝执行。命名空间固定，防止旧 URL 意外指向不同用户服务。

```bash
node bin/lark-channel-bridge.mjs a2a alias 'session-<UUID>' --alias project-c --profile my-bot
node bin/lark-channel-bridge.mjs a2a revoke c-series --key-id '<密钥ID>' --profile my-bot
node bin/lark-channel-bridge.mjs a2a disable 'session-<UUID>' --profile my-bot
```

如果已经将 `c-series` 改成 `project-c`，撤销命令应使用新别名或永久别名。密钥仅存 SHA-256 摘要，状态文件权限 0600。密钥绑定具体 FF、调用者 ID 和签发时查询到的飞书应用所有者；转移应用所有者后旧密钥失效。普通密钥可委派本机调试等当前辅助权限允许的任务；受限操作通过飞书私聊当前所有者确认，两按钮、1 小时有效，同意后只放宽本次具体动作。

仅给所有者自用 agent 签发不受辅助限制的密钥：

```bash
node bin/lark-channel-bridge.mjs a2a grant c-series --name owner-agent --owner --profile my-bot
```

`--owner` 是本机管理者的显式授权；请求体中任何 owner/role 声明都不能获得该身份。接口不依赖调用者飞书群成员身份，持有密钥即具备对应 FF 访问资格，请分别签发、按需撤销。API 的权限限制复用现有提示词与审批软约束，不是独立操作系统沙箱。

当前提供内网 HTTP 监听；密钥在网络上传输时未加密，需要可信内网或受保护隧道。跨不可信网络部署时需增加 TLS，并将 Agent Card 的公开地址配置/适配为实际 HTTPS 入口；第一版不自动配置反向代理或公网发布。

## 给调用者的说明

每个接口提供受密钥保护的 Agent Card：

```text
http://10.88.80.121:36999/LennoxGao/agents/c-series/agent-card.json
```

将此地址、单独提供的普通密钥、以及以下说明给调用者即可：

```text
这是项目助手的 A2A 1.0 HTTP+JSON 接口，作为任务委派工具使用，不作为通用模型供应商配置。
使用提供的 Bearer 密钥读取 Agent Card；后续请求发送 A2A-Version: 1.0。
每次提交一个文本任务，生成唯一 messageId，configuration.returnImmediately=true。
取得 task.id 后每秒 GET /tasks/{id}，以 artifacts 中当前完整文本替换显示。
TASK_STATE_AUTH_REQUIRED 表示服务端正在飞书请所有者确认，继续查询同一 task，不要代替所有者批准。
终态包括 COMPLETED、FAILED、CANCELED、REJECTED（均带 TASK_STATE_ 前缀），到达终态后停止轮询。
不要自动重提失败或状态不明的执行任务。网络中断先查原 task；确需重试提交时保持原 messageId 和相同内容。
同一助手的各入口共用历史；本次问题和调试信息会进入共享 FF，但 API 进展与结果不发到群。
```

仓库提供无第三方依赖的 Python 客户端，不需要调用者自行拼协议：

```bash
# 通过安全方式将密钥放入 A2A_TOKEN 环境变量，勿提交进代码。
python3 tools/a2a-client.py --agent-card '<Agent Card 地址>' \
  --question '检查联调环境，分析连接失败原因' --request-id debug-001

python3 tools/a2a-client.py --agent-card '<Agent Card 地址>' --get '<task.id>'
python3 tools/a2a-client.py --agent-card '<Agent Card 地址>' --cancel '<task.id>'
```

加 `--watch` 会依次输出变化后的完整文本快照；GUI 可直接用新文本替换旧文本。客户端拒绝跨站重定向及向不同来源的接口转发密钥。默认轮询超时 30 分钟，超时不会取消任务；继续查询同一 task 即可。

## HTTP 请求与结果

以下路径均相对于某个助手的 base URL。Agent Card 和所有业务请求均需 `Authorization: Bearer <密钥>`。业务请求必须明确发送 `A2A-Version: 1.0`，不自动将旧版 0.3 协议当作 1.0 解析。

| 操作 | 路径 | 返回 |
|---|---|---|
| 能力说明 | `GET /agent-card.json` | Agent Card |
| 提交 | `POST /message:send` | `{ "task": Task }` |
| 查询完整快照 | `GET /tasks/{id}` | Task |
| 取消本次任务 | `POST /tasks/{id}:cancel` | Task |
| 只列本密钥的任务 | `GET /tasks` | `{ "tasks": [...], "nextPageToken": "..." }` |

```json
{
  "message": {
    "messageId": "debug-001",
    "role": "ROLE_USER",
    "parts": [{"text": "检查当前联调环境，分析连接失败原因"}]
  },
  "configuration": {"returnImmediately": true, "historyLength": 0}
}
```

遵循 A2A 默认行为：不传 `returnImmediately` 或传 false 时等到终态或等待确认再返回；建议长任务明确传 true。`contextId` 可省略，服务按密钥和入口分配稳定的外部上下文 ID；不接受其他上下文。第一版不支持通过 `taskId` 发新消息，继续提问应提交一个新 task。

查询返回本次任务的全量输出，不是全会话历史：

```json
{
  "id": "服务器生成的任务UUID",
  "contextId": "ctx_...",
  "status": {"state": "TASK_STATE_WORKING", "timestamp": "2026-10-15T12:00:00.000Z"},
  "artifacts": [{"artifactId": "answer-...", "name": "answer", "parts": [{"text": "已检查连接配置，正在分析日志。"}]}],
  "metadata": {"revision": 5}
}
```

结果可能被修正，应替换全文，不能假定仅在末尾追加。`historyLength=0` 默认不返回输入历史；大于零最多返回本任务自身的输入，不包含其他任务。列表支持 `pageSize`（1–100）、`pageToken`、`contextId`、`status`（完整 TASK_STATE 枚举）、`statusTimestampAfter`、`includeArtifacts=true` 和 `historyLength`；默认列表不附带输出正文。

<a id="project-assistant-v1"></a>

Agent Card 通过可忽略的 `capabilities.extensions` 描述本项目约定：`params.aliases` 为同时有效的别名，`sharedContext=true` 表示多个入口共享上下文，`partialArtifacts=true` 表示任务执行中可查询当前完整正文，`pollIntervalMs=1000` 为建议轮询频率。这些信息放在规范允许的扩展参数中，不给 Agent Card 增加私有顶层字段。

## 执行、取消与恢复边界

- 关联同一原会话的入口使用共享执行锁；原 AA 工作群沿用 native 锁/原生队列。不同会话可并行。
- 单请求问题最多 50000 字符，输出最多 1MB；每把密钥最多 4 个未结束任务，全服务最多 32 个。等待审批也占任务额度。
- 相同入口 + 密钥 + messageId 提交相同内容返回同一个 task，跨默认/易读别名及重启仍去重；不同内容返回 409。
- 取消只作用于本任务，停止请求不能回滚已完成操作。取消待排队任务后不会启动它；重复取消返回原取消状态。
- 密钥撤销、入口关闭、原会话归档或所有者变化时，重新核验并阻止后续步骤，活动运行也会请求停止。仅归档一个辅助群，不影响其他有效入口。
- 每次仅附加简短的权限与投递 JSON，不读取来源快照或维护提示词周期。API 包装中不提供任何飞书投递目标，回答/调试进展不投递到群；审批卡例外，只发所有者私聊。
- 默认后台服务仅在配置存在且 enabled 时监听。监听失败记录错误，但不让原有飞书桥接停止服务。
- 请求、部分输出、审批卡及继续执行声明持久化。桥接重启不取消独立 worker/Codex 已接收的任务；API 对重启时的排队/运行记录标记“结果未确认”，保留已有快照且不自动重跑。第一版不重建这些任务的输出观察器，后续执行结果需在 原 AA 工作群/原生会话检查。
- 待确认任务重启后仍可确认；继续动作在提交前持久化认领，结果不明时不再次执行。普通失败也不会自动创建新任务重试。

管理配置：profile 目录下的 `a2a.json`；任务记录：`a2a-tasks.json`；辅助 scope 和审批继续存于现有 `auxiliary-groups.json`、`ff-approvals.json`。这些文件含内部信息或项目内容，不应发布给调用者。
