# 测试

常规检查：`pnpm test`、`pnpm typecheck`、`pnpm build`。真实飞书集成测试默认关闭，不会随常规测试发送消息或创建群。

## 真实 worker / 原生工具 / 飞书验证

```bash
BRIDGE_LIVE_SMOKE=1 \
BRIDGE_LIVE_PROFILE=lennox-codex \
BRIDGE_LIVE_TOOLS=codex,zcode,kilo \
BRIDGE_LIVE_WORKSPACE=/home/pc/code/pc_localtask \
pnpm test:live:bridge
```

当前原生测试驱动支持 Codex、ZCode、Kilo。其他 worker 尚未纳入本轮真实验证。测试使用 `workers/*/endpoint.json` 自动发现部署中的 worker，读取其能力声明，并通过统一 worker 接口检查会话和消息。真实输入、创建和改名通过各工具自己的原生接口完成；ZCode 原生输入使用官方远控 V4 的 `sendText`，由原生工具记录 `mobile` 来源。飞书输入和群改名使用群主的用户身份。

运行条件：桥接服务和目标 worker 在线；各工具已登录且模型有额度；ZCode 桌面已打开指定项目并配置远控链接；群主的 `lark-cli --profile <机器人 app ID> --as user` 授权包含发消息、读群消息、更新群和个人群免打扰权限。测试不会自行登录或替换账号。

每个工具复用 `AA-飞书桥接-autotest` 会话；不存在时才创建。新会话在 `BRIDGE_LIVE_WORKSPACE` 项目路径下创建。已存在会话若路径不同、已归档、身份不明确或记录的 ID 失效，测试报错，不另建同名会话。创建返回的原生 ID 在后续改名之前保存，便于部分失败后复用。

验证步骤：等待生产桥接自动建群及一对一绑定；设置并查询群主的免打扰状态；群消息进入原生会话，模型回复返回飞书；原生输入及回复同步到飞书，且输入具有原生来源；会话改名同步到群，群改名同步到会话。消息阶段失败后仍继续独立的改名检查，整体结果仍为失败。测试结束恢复测试开始时的名称，保留会话和已免打扰的群供下次复用。

`BRIDGE_LIVE_HOME` 可指定状态根目录，默认 `~/.lark-channel`。测试加载目标 profile 的 `runtime.env`。持久记录和报告位于 `<profile>/autotest/`：`sessions.json` 保存原生 ID、项目路径和群 ID；`reports/*.json` 保存阶段、结果和失败原因。报告不包含聊天正文或凭据。全套真实测试持有排他锁，避免并发运行创建重复会话或交叉改名。

## 2026-10 测试清理

删除 43 项测试，保留权限、归档、兼容迁移、消息去重、回调、锁和时钟回归等行为覆盖：

- 旧 `codex-turn-sync` 的 29 项测试：生产桥接已改用统一 worker 及 `startNativeTurnSync`，没有生产入口再调用这个旧实现。保留统一同步、来源识别、worker 恢复、问答及回复测试。
- 类型源码正则 3 项、CLI 注册字符串 2 项、README 文案字符串 6 项：分别由类型检查、CLI 集成测试及文档审查承担。
- 启动代码源码顺序 2 项、策略源码 IO 字符串检查 1 项：不再将文本排列当作行为验证；保留工厂、重连限制、运行时锁及策略行为测试。

新增自动建群暂停后补扫和停止后不补扫的回归测试，防止每分钟群清理与建群扫描定时器重合时长期漏建群。保留静态架构边界和私有状态原子写入检查。
