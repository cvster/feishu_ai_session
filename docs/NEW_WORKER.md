# 新工具接入简介

桥接与内置网页通过统一 worker API 使用工具。工具的原生 SDK、CLI、桌面连接、账号目录和模型供应商配置由 worker 管理。

## 接入步骤

1. 选一个稳定的 `toolId`（小写字母开头，仅字母、数字、`_`、`-`，最长 64 位）和稳定的 `sourceId`。后者区分账号/历史来源，不能每次启动随机生成。
2. 实现 [Worker API](WORKER_API.md) 的身份与能力声明、持久任务收据及归一化事件。可以复用本仓库的 `src/worker/server.ts`、`src/worker/store.ts` 和 `src/worker/protocol.ts`；外部进程也可以直接实现 HTTP 协议。
3. 在对应 profile 的 `workers/<任意目录>/` 发布 `endpoint.json`，权限 600，内容包含协议版本、回环 URL、随机 Bearer Token 和进程 PID。使用原子写入；重启更新 URL/PID，任务收据和原生会话 ID 保持稳定。
4. `/health` 返回与 profile 一致的 `botAppId`，以及 `toolId`、`sourceId`、manifest 和 capabilities。每个路由都验证 Bearer Token。桥接自动遍历存在 endpoint 的目录，认证并检查身份；不按目录名识别工具。
5. 启动 worker 后等待发现刷新。工具名称取自 manifest，支持的操作取自 capabilities；个人会话群、复制/创建菜单与网页复用通用逻辑，不额外增加桥接工具配置或工具分支。

`endpoint.json` 的格式：

```json
{
  "version": 1,
  "url": "http://127.0.0.1:12345",
  "token": "replace-with-a-random-private-token",
  "pid": 123
}
```

## 能力逐步接入

| 功能 | worker 需要实现 |
| --- | --- |
| 群内执行、停止及重启后回复续传 | `/jobs` 提交/列表、按事件游标读取、停止；稳定 requestKey 去重和持久 journal |
| 创建与绑定个人会话群 | `/sessions` 返回稳定 nativeId、名称、真实项目目录、时间及归档状态；接受新任务创建会话 |
| 网页/群/原生界面消息同步 | `/sessions/:id/conversation`，将输入、答案及状态归一化；准确标记 bridge 轮次并关联 job，避免重复 |
| 名称双向同步 | 原生名称能力与 rename 接口，修改后列表/快照也反映新名称 |
| 模型与推理设置 | `/models`、会话推理档位读取；声明 `reasoningMapping`，在 worker 中映射统一档位，事件记录实际模型/档位 |
| 真复制、原生归档、问答 | 按支持情况实现 fork/archive/questions/answer 并声明能力；不支持返回 501，禁止假报成功 |

完整请求字段、manifest 示例、事件及能力版本以 [Worker API](WORKER_API.md) 和 `src/worker/protocol.ts` 为准。工具不支持真复制时，通用流程创建新会话并提供读取原会话内容的入口。

## 验收与部署

用测试 profile 验证任务重复提交只执行一次、输出游标重连可续读、不同账号 sourceId 不混用、会话/群名双向改名、归档和断线状态准确。然后验证飞书与 Web 的同一会话收发和控制按钮；可参考 `tests/integration/worker/` 及 `tests/integration/tools/personal-tools.test.ts`。

外部 worker 由自己的进程管理器托管，桥接发现 endpoint 不会启动它。仓库内置工具可用 `worker start --tool <工具>`；该 CLI 的运行适配器不是任意外部程序启动器。日常部署只更新桥接与网页，新工具单独启动；已有 worker 和 Codex writer 保持运行。涉及 worker 原生适配逻辑的更新，再单独部署相应 worker。
