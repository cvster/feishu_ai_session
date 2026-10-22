# 统一 worker 迁移

桥接只扫描当前 profile 的 `workers/*/endpoint.json`，调用统一 HTTP 接口。Codex
也需要独立 worker；只用 Kilo 的部署无需安装 Codex。Kilo App/Desktop 已移除，
保留 VS Code 插件及独立 CLI。旧 App 会话仍保留在原生数据库中，但不会列出或续聊。

## 配置与目录

根 `config.json` 保留机器人、权限、工作目录、默认工具和展示偏好。原生执行设置由
`profiles/<profile>/workers/<tool>/config.json` 管理：

```json
{
  "version": 1,
  "toolId": "kilo",
  "options": { "binaryPath": "kilo", "editorSync": true }
}
```

旧根配置的 `codex/claude/kilo/zcode/dsh` 设置在首次迁移时导入 worker 配置，然后从根
配置移除。已有 worker 配置优先，重启不覆盖。兼容备份位于
`workers/legacy-profile.json`。旧 Kilo `preferredClient` 设置丢弃；原生历史不删除。
原来的 Codex Home、账户目录和权限隔离设置保持不变。

| 旧目录 | 新目录 |
| --- | --- |
| `execution-worker` | `workers/claude` |
| `execution-worker-kilo` | `workers/kilo` |
| `execution-worker-zcode` | `workers/zcode` |
| `execution-worker-dsh` | `workers/dsh` |
| 原生 Codex 队列 | 仍由原 writer 持有；worker 自身状态在 `workers/codex` |

目录移动保留 `jobs/` 中的收据和事件。新旧目录同时存在时拒绝覆盖。旧 worker 还在监听
时拒绝移动目录，需要单独停止对应旧 worker；迁移代码不会自动停止任何服务。

## 升级步骤

1. 保存旧构建和 profile 数据备份，构建并检查新代码。
2. 为每个需要迁移的旧 worker 安排独立升级，停止该旧 worker 后迁移它的状态目录。
   `worker stop` 属于 worker 维护，会影响它持有的任务；不属于常规桥接重启步骤。
3. 用新构建启动需要的 worker，例如：

   ```bash
   lark-channel-bridge worker start --profile my-bot --tool codex
   lark-channel-bridge worker start --profile my-bot --tool kilo
   lark-channel-bridge worker status --profile my-bot --tool kilo
   ```

   Linux 使用用户级 systemd；其他系统使用 `worker run --profile my-bot --tool kilo`
   配合进程托管。只启动实际使用的工具。Codex writer、VS Code 和原生应用单独管理。
4. 更新并重启桥接，查看发现的工具及会话列表，验证一条消息和原卡片更新。
   无 worker 时桥接仍可启动；工具离线时不会改绑已有群。

## 数据兼容

群绑定和原生会话 ID 保留。旧 Codex intake 收据导入 `codex-inbox.json`：只有从未
提交的 `pending` 恢复入队；已提交、回执不确定或完成的记录不重发。旧原生同步卡片
导入 `<tool>-native-turn-sync.json`，保留消息 ID、卡片 ID、序号和去重记录。缺少
可靠投递凭据的旧记录跳过自动补发。旧 Codex 问答卡 token 和投递记录继续可用；
重启时尚在提交的答案转为未确认，不能自动再次提交。

日常桥接重启不停止 worker 或原生 writer。worker/主机重启后的未完成任务状态
仍可能不确定，不自动重跑。代码提交、推送本身不会更新任何运行服务。
