# 飞书机器人权限与事件申请清单

适用于本仓库的 Codex / Claude 飞书桥接。核对日期：2026-10-15。以下标识来自当前代码调用和飞书官方文档；平台后台名称、租户审批策略可能变化，以对应接口文档和申请页面为准。

## 1. 申请前先确定身份与范围

桥接收发消息、建群、更新卡片和辅助群退群使用 **应用身份**（`tenant_access_token` / `--as bot`）。下表默认均为应用身份权限；只给个人用户授权不能代替应用开通权限。

在 [飞书开发者后台](https://open.feishu.cn/app) 打开自己的应用：

1. 启用机器人能力，设置名称与头像。
2. 在权限管理中按下表的 scope 标识搜索、添加，按租户要求申请审批。
3. 在“事件与回调”配置长连接、所需事件和卡片回调。
4. 设置应用可用范围，覆盖实际使用的自己与同事；仅勾选权限不等于用户都能使用。
5. 创建并发布应用版本；涉及审批时等待通过，再验证权限生效。
6. 将机器人加入目标群。辅助群还需由应用所有者在私聊完成会话关联。

桥接默认通过 WebSocket 长连接接收事件，无需为此架设公网回调服务。平台操作说明见 [长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)。

## 2. 基础聊天、文件与卡片

这是一般部署的推荐组合，覆盖私聊控制台、群内 @ 提问、附件与流式卡片。不是声明每一项都适用于所有接口；条件和替代权限见官方文档。

| 应用权限标识 | 用途 | 对应官方接口或事件 |
| --- | --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息 | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) |
| `im:message.group_at_msg:readonly` | 接收用户在群内真实 @ 机器人的消息 | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) |
| `im:message:send_as_bot` | 机器人发消息、回复、发文件和卡片；也可用于更新已发送卡片 | [发送](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[回复](https://open.feishu.cn/document/server-docs/im-v1/message/reply)、[更新卡片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch) |
| `im:message:readonly` | 按 ID 读消息、下载消息中的附件；群历史还可能需下一节的全部群消息权限 | [读消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)、[下载资源](https://open.feishu.cn/document/server-docs/im-v1/message/get-2) |
| `im:resource` | 上传图片和文件，生成卡片按钮图片、群头像及发送文件所需资源 | [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create) |
| `cardkit:card:write` | 创建和更新 CardKit 2.0 卡片、流式回复 | [创建卡片](https://open.feishu.cn/document/cardkit-v1/card/create)、[更新卡片](https://open.feishu.cn/document/cardkit-v1/card/update) |
| `im:chat:read` | 查询群名、群模式、群主和成员数量；验证辅助群关联时机器人仍在群内 | [获取群信息](https://open.feishu.cn/document/server-docs/group/chat/get-2) |
| `application:application:self_manage` | 读取本应用信息、识别应用所有者及已授权 scope | [获取应用信息](https://open.feishu.cn/document/server-docs/application-v6/application/get) |

`im:resource:upload` 是上传接口的另一种可选权限；上述组合使用 `im:resource`，不要求两个都申请。更新消息卡片接口接受 `im:message:send_as_bot` 或 `im:message:update` 等权限之一；常规组合已能覆盖，无需为了卡片更新重复申请。

读取应用自身信息优先使用 `application:application:self_manage`，不要仅为识别所有者申请企业级的 `admin:app.info:readonly`。本项目使用 `open_id`，基础桥接不要求读取所有员工邮箱、手机号或申请全量通讯录。

## 3. 个人工作群（含 AA 会话群）与 FF 辅助群

启用个人工作群与辅助群生命周期时，在基础组合上增加：

| 应用权限标识 | 用途 | 对应官方文档 |
| --- | --- | --- |
| `im:chat:create` | 从私聊创建个人工作群、为 AA 会话自动建群、辅助群成员请求创建私聊群 | [创建群](https://open.feishu.cn/document/server-docs/group/chat/create) |
| `im:chat:update` | 修改绑定群的名称、头像等可管理信息 | [更新群信息](https://open.feishu.cn/document/server-docs/group/chat/update-2) |
| `im:chat.members:bot_access` | 订阅机器人入群事件，触发私聊关联流程 | [机器人进群](https://open.feishu.cn/document/server-docs/group/chat-member/event/added-2) |
| `im:chat.members:write_only` | 所有者要求退出辅助群时，将当前应用机器人自身移出群 | [移出群成员](https://open.feishu.cn/document/server-docs/group/chat-member/delete) |

进一步按实际功能选择：

| 应用权限标识 | 何时需要 |
| --- | --- |
| `im:chat:operate_as_owner` | 机器人创建群后将群主交给人类，但仍需管理其创建的群时；不是任意群的管理权 |
| `im:chat.members:read` | 创建或复用 FF 私聊群时核验来源群成员资格和私聊群成员完整性；也用于 CLI 查询群成员列表 |

群管理权限不能代替群内角色校验，不能管理旧机器人或他人创建的任意群。本版归档保留飞书群，由用户自行解散；归档不需要申请 `im:chat:delete`。见 [群成员列表](https://open.feishu.cn/document/server-docs/group/chat-member/get)。

### 所有者的消息免打扰（用户身份）

新建工作群（含 AA / FF 个人工作群、辅助私聊群）和关联 FF 辅助群时，桥接通过主 `lark-cli` 为当前应用所有者设置 `is_muted=true`。这是所有者自己的普通消息通知偏好，不修改其他成员或 `@所有人` 的提醒设置，也不改变机器人是否处理消息。仅在创建或关联时应用，不会定期覆盖用户之后的手动修改。

主 CLI 需绑定同一个应用、以该应用所有者登录，申请并完成用户授权：

| 用户权限标识 | 用途 |
| --- | --- |
| `im:chat.user_setting:write` | 开启当前用户的群消息免打扰 |
| `im:chat.user_setting:read` | 批量迁移、读回验证现有群的免打扰状态；自动建群设置本身不要求此权限 |

桥接先核对应用 ID 和当前所有者的 `open_id`，匹配后才以 `--as user` 调用 `im chat.user_setting batch_update`。只使用主 CLI 的已有授权，不读取或传递用户 token，不放开 Agent 专用 CLI 的 bot 身份限制。主 CLI 使用标准配置目录；自定义目录可为桥接设置 `LARK_CHANNEL_OWNER_CLI_CONFIG_DIR`。未登录、身份不符、缺权限或用户不在群内时仅记录警告，不阻断建群或关联，也不自动发起授权。

### 可复制的常规组合

覆盖“私聊控制台 + 个人工作群 + FF 关联与退出 + 文件和卡片”的申请标识如下。按上一节判断是否另加群管理权限：

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:send_as_bot
im:message:readonly
im:resource
cardkit:card:write
im:chat:read
application:application:self_manage
im:chat:create
im:chat:update
im:chat.members:bot_access
im:chat.members:write_only
```

可以给管理员的用途说明：

> 用于企业内部飞书 AI 编程助手：接收用户私聊和群内 @ 请求，调用本地已登录的 Codex / Claude；以机器人身份回复、传送用户要求的文件、更新进度卡片；创建会话工作群，监听机器人入群并由所有者关联辅助会话，按所有者指令主动退群。权限和数据范围按所启用功能配置。

## 4. 全部群消息、引用历史与表情提示

| 应用权限标识 | 用途及边界 |
| --- | --- |
| `im:message.group_msg` | 获取群内所有用户消息。普通群“不 @ 也响应”需要此权限及配置开关；读取已有群消息、引用或群历史也可能需要它 |
| `im:message.reactions:write_only` | 添加、移除“正在处理”等消息表情提示 |
| `im:message.reactions:read` | 专门读取表情回复或订阅相关事件时；部分接口也接受 `im:message:readonly`，按接口选择即可 |

`im:message.group_msg` 是敏感权限，不是仅接收用户 @ 的必要条件。但 [按 ID 获取群消息](https://open.feishu.cn/document/server-docs/im-v1/message/get) 的应用身份调用在基础读消息权限之外还要求全部群消息权限；如果需要引用、话题补全或 CLI 读取历史，应一并申请。资源下载有自己的权限要求，不要把两者混淆。

辅助群的入口始终要求真实 @ 人类消息。即使申请了全部群消息权限，辅助群也不会因此开始响应普通闲聊；普通工作群的响应开关是另一层设置。当前只处理人类提问，无需为此申请接收其他机器人消息的权限。接收规则见 [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。

## 5. 事件与回调清单

权限授权与事件订阅是两个步骤；只申请 scope 不会自动把事件推到桥接。

| 事件 / 回调标识 | 必要性 | 用途 |
| --- | --- | --- |
| `im.message.receive_v1` | 必需 | 接收私聊和群消息；消息范围由已授权 scope 决定 |
| `card.action.trigger` | 必需的卡片回调 | 控制台、关联选择、停止、刷新和选项表单 |
| `im.chat.member.bot.added_v1` | 自动关联辅助群必需 | 机器人被添加到群后通知所有者 |
| `im.message.reaction.created_v1` | 按需 | SDK 支持的新增表情事件 |
| `im.message.reaction.deleted_v1` | 按需 | SDK 支持的删除表情事件 |
| `drive.notice.comment_add_v1` | 仅云文档评论功能 | 文档评论中 @ 机器人 |

在后台分别检查事件配置与回调配置，并使用长连接模式。卡片折叠 / 展开本身由飞书客户端处理，不需要新增业务权限或自定义按钮回调。

平台也有机器人被移出群事件，但当前 channel SDK 的桥接接入只暴露 `botAdded`，不能仅靠后台勾选事件就宣称已实现被动退群自动归档。桥接另在启动时及每分钟通过 `im.v1.chat.get` 分批检查关联群（每批最多 50 个），明确确认群已解散后清理本地路由；使用既有群信息读取权限，不需要解散群权限。机器人被移出、权限不足或查询失败时保留关联，不冒充群已解散。原生会话历史及其他关联群保留，详见 [群清理机制](CODEX_TASK_LIFECYCLE.md#dissolved-groups-lose-their-live-bridge-routes)。

## 6. 云文档与个人资源按需申请

只做群内编程问答和传文件，不需要顺便申请日历、邮件、审批、考勤或整个云盘权限。

- **云文档评论**：按实际调用申请 `docs:document.comment:read` 及 `docs:document.comment:create` / `docs:document.comment:write_only` 等相应权限，再订阅评论事件并开放目标文档访问。还需读取正文或修改文档时，按对应文档类型补权限。[读评论](https://open.feishu.cn/document/server-docs/docs/CommentAPI/list)、[写评论](https://open.feishu.cn/document/server-docs/docs/CommentAPI/create)。
- **个人日历、云盘、邮箱等**：按具体 `lark-cli` 功能申请用户身份 scope，再由实际用户授权；应用身份授权不能代替用户授权，也不能绕过目标资源的共享 / 数据范围。
- **普通桥接默认 bot-only**：使用 profile 隔离的 CLI 配置。需要用户身份时按管理员策略切换；不要把自己的用户登录目录直接共享给所有部署者。

## 7. 发布后的验收

1. **私聊**：所有者发“新建会话”，应收到控制台卡片，按钮能触发操作。
2. **个人工作群**：创建一个测试群，真实 @ 提问，检查流式回复和刷新。
3. **辅助关联**：由所有者拉机器人进测试群，收到私聊关联卡片；选择来源会话后在群内 @ 提问。
4. **文件**：发送小图片 / 文件供机器人读取，再要求把一个允许发送的脚本发回本群；以真实附件消息为成功依据。
5. **折叠**：长回答可展开；结束后状态和按钮在详情区内。
6. **主动退出**：在专用测试辅助群内由所有者真实 @ 发送“退出”，确认机器人离群；不是解散整个群。

按需再测试全部群消息、文档评论等功能。不要通过无关群的管理操作来测试权限。

## 8. 常见问题

| 现象 | 先检查 |
| --- | --- |
| 有私聊无群回复 | 群 @ 消息权限、消息事件、真实 @、机器人在群和应用可用范围 |
| 有回复但无按钮效果 | `card.action.trigger` 回调、长连接、真实操作人的访问权限 |
| 入群没有私聊关联卡片 | `im:chat.members:bot_access`、机器人进群事件、邀请者是否应用所有者；私聊 `/aux` 查看待关联 |
| 读消息 / 引用失败 | 基础读消息权限，以及群内场景是否额外需要 `im:message.group_msg` |
| 能发文字但无法流式更新 | `cardkit:card:write`、CardKit 接口业务错误和卡片大小 |
| `99991672` / `99991679` | 检查返回的缺失 scope、调用身份与已发布版本；不要把 HTTP 400 一概视作参数错误 |
| `232017` | 群主 / 群创建者等管理身份及 `im:chat:operate_as_owner`，不只是 scope 是否勾选 |
| 应用能用，但同事找不到 | 应用可用范围、发布 / 审批状态及桥接访问控制 |

本仓库已修复辅助群关联时使用旧 `members/is_in_chat` 导致的 400：现在用 `chat.get` 和 `im:chat:read` 校验机器人在群内，不必为该旧接口额外申请一组旧权限。进群事件仍需要单独的事件权限与订阅。

新申请优先使用表中的细粒度 scope。旧应用若已有 `im:chat`、`im:message` 等较宽权限，不必仅为匹配本文重复申请；具体接口通常列有多个可替代 scope，需分别核对。迁移时逐项验证后再移除旧权限。


## FF 私聊群

成员在已关联辅助群中 `@机器人 私聊`，复用现有建群接口，创建包含请求者、应用所有者和机器人的私有群。桥接应用需要 `im:chat:create`、`im:chat:read`、`im:chat.members:read`，以及现有群 @ 消息接收和机器人发送权限。创建群时通过 `user_id_list` 邀请成员，不额外调用加人接口；退出仍使用 `im:chat.members:write_only`。应用可用范围须包含相关成员及所有者；平台权限需实际发布生效。

创建前核验请求者仍是来源群成员，创建后或复用已有私聊群时核验成员完整；查询失败不按群 ID 直接放行。旧 `ff-dm-v1`、`/ff` 私聊问答已停用，同事无需为此配置机器人搜索或额外用户 CLI 授权。其他 agent 若通过飞书群发送消息，仍须使用各自真实用户身份及相应群消息权限；也可使用独立的 A2A 接口。


## FF 受限操作确认

确认使用现有机器人消息与 CardKit 交互能力：发送机器人消息、`cardkit:card:write`、`card.action.trigger` 回调，以及识别应用所有者的应用信息权限。辅助群及私聊群的卡片使用真实所有者 open_id 的 @；A2A API 调用的确认卡发到所有者私聊。无需另申请原生飞书审批权限。确认只能对辅助提示词规则中的具体操作放宽，平台缺失 scope、账号授权或系统文件权限仍需实际开通。
