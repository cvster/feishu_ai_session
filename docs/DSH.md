# DeepSeek Harness（DSH）接入

工具名称为 **DeepSeek Harness**，桥接工具 ID 为 `dsh`。本版验证官方 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2`，使用原生 Web HTTP RPC 与 WebSocket 会话事件，不依赖屏幕操作或解析终端聊天文本。

## 安装和模型配置

使用 Node 24（本机为 24.20.0）：

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
dsh --version
dsh web
```

在 DSH 的模型设置页配置自己的供应商、API 凭据和默认模型。安装本身不包含模型授权或额度；模型目录可见也不表示账号可实际调用。桥接不自动复制其他工具的 API key。

DSH 默认读取 `~/.dsh`，也支持原生 `DSH_HOME`。桥接配置可选：

```json
{
  "dsh": {
    "binaryPath": "/absolute/path/to/dsh",
    "homeDir": "/home/you/.dsh"
  }
}
```

可选 `args` 原样放在 DSH 启动参数之前，可用于原生 `--patch` 配置；供应商和凭据仍由 DSH 管理，不放进桥接仓库。桥接和 worker 必须使用同一个 `homeDir`，不要在已有群上切换数据源。二进制选择顺序为 profile 配置、`LARK_CHANNEL_DSH_BIN`、PATH 中的 `dsh`。

## 独立 worker 与使用

从本仓库构建并部署后执行：

```bash
node bin/lark-channel-bridge.mjs doctor --profile my-bot --agents dsh
node bin/lark-channel-bridge.mjs worker start --profile my-bot --tool dsh
node bin/lark-channel-bridge.mjs worker status --profile my-bot --tool dsh
```

Linux 服务为 `lark-channel-worker.dsh.my-bot.service`，状态目录为 profile 下的 `execution-worker-dsh`。其他系统可用 `worker run --profile my-bot --tool dsh` 自行托管。新增 DSH 只需启动它的 worker、更新桥接；已有 Claude、ZCode、Kilo worker 不需要重启。

私聊机器人选择“新建会话”→ **DeepSeek Harness** → 项目目录。已有 DSH 会话改为 `AA` 开头也可自动建群。使用独立的蓝底 DSH 鲸鱼头像，支持停止和复制会话按钮。工作群、共享 FF、辅助私聊群、权限确认与 A2A 复用现有机制，不需新增飞书权限。

## 动态模型和会话

- `/config` 刷新时调用 DSH 原生 `session/modelCatalog`，逐个保留供应商、模型 ID 和模型自己的 reasoning efforts；不使用其他工具的模型清单，也不硬编码模型或档位。
- 值为 `供应商ID/模型ID`，模型 ID 内的斜杠保留。同名供应商附带实际 ID。删除已选模型或档位后拒绝提交并提示重选，不静默换供应商。
- 恢复会话优先使用 DSH 会话记录中的模型和档位。显式选择通过原生 `session/selectModel`，该接口也会按 DSH 自身行为保存默认模型；其他已有群仍保留自己的会话选择。
- 改名、复制、归档分别使用原生 Session / Workspace 接口。归档保留历史，不删除会话或项目文件。FF 读取来源时只使用冷读取接口，并生成本机私有历史快照，不向来源发送消息。
- 普通消息原样提交，FF 保持完整/精简 JSON 提示周期。附件当前通过本机文件路径上下文提供，不宣称已接入 DSH 的原生图片上传协议。

## 执行边界

- 每次执行由独立 worker 持有一个自己启动的 DSH Web 后端，仅绑定 `127.0.0.1`、使用随机端口和原生登录 cookie。启动 token、cookie、供应商凭据及原生日志不输出到飞书或桥接日志。
- 先订阅会话流再提交，按本次 `requestId` 的入队凭证和 Session 序号过滤事件；去重实时文本与持久化正文，等待本次 turn 结束及 Agent idle。回执不明、连接断开不自动重发问题。
- 停止调用本次会话的 `session/cancel`；必要时仅关闭本次拥有的 DSH 子进程，不停止用户自己的 DSH Web/桌面进程。
- 每次执行按桥接访问模式设置并回读 DSH 原生 `/permission`：`read-only`、`workspace-write`、`danger-full-access`。设置失败不提交问题。具体隔离能力由 DSH 和本机环境决定；FF 业务限制仍为既有提示词约束。
- 原生交互问答和权限弹窗尚未转接到飞书，不自动回答或同意。检测到原生问题时停止；桥接的既有超时与停止机制仍可终止等待。
- 不支持编辑器、独立 DSH Web 与飞书同时写同一原生会话；请使用同一入口串行操作。独立 worker 可跨桥接重启持有执行，worker/主机重启不保证任务继续。

参考：[官方项目](https://github.com/deepseek-ai/deepseek-harness)、[社区 Linux 安装教程](https://deepseekdsh.com/tutorials/linux)。上游仍在快速迭代，升级 DSH 后应重新验证原生协议兼容性。
