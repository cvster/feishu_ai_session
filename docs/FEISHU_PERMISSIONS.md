# 飞书权限申请清单

本清单供其他人安装 Codex、Claude、Zcode、Kilo 和 Dsh 飞书桥接时，为自己的飞书应用申请权限。清单取自已配置的参考机器人 Lennox-AI助手，完整列出其 245 项权限，供复现相同能力。

所有权限统一在下方一张表中，每个 scope 一行。安装者在自己的飞书开发者后台，按表中的权限标识搜索、申请并发布；无需访问参考机器人的账号或执行权限采集命令。

## 安装时如何申请

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建或打开自己的应用，启用机器人能力。
2. 按统一表申请权限。要复现参考机器人的完整能力，请逐项申请；表中的“支持身份”用于选择应用 / 机器人或用户身份，同一个 scope 支持两者时按所需身份分别开通。
3. 配置下文列出的事件和卡片回调，使用长连接；设置应用可用范围，覆盖实际使用人员。
4. 按租户要求完成审批，创建并发布应用版本，再进行下文的验收。
5. 使用用户身份的功能，还需要实际使用者完成 OAuth 授权，并具备目标资源的访问权。

“应用 / 机器人”对应 `tenant_access_token`，“用户”对应 `user_access_token`。支持用户身份的权限不会自动成为机器人身份权限；后台开通用户 scope 也不等于用户已完成授权。参考机器人的 App ID 只标注清单来源，安装者应使用自己的 App ID 和凭据。

## 统一权限申请清单

<!-- feishu-permissions:start -->

核对日期：2026-10-28。清单来源（参考机器人）：Lennox-AI助手（`cli_aa36351590381bcd`）。共 **245 项**，其中 118 项支持应用 / 机器人身份，225 项支持用户身份；每个权限标识仅列一次。

| 权限标识 | 后台名称 | 支持身份 |
| --- | --- | --- |
| `application:app_slash_command:read` | 查询 Slash Command | 应用 / 机器人、用户 |
| `application:app_slash_command:write` | 编辑 Slash Command | 应用 / 机器人、用户 |
| `application:application:self_manage` | 管理应用自身资源 | 应用 / 机器人 |
| `application:bot.basic_info:read` | 获取机器人的基本信息 | 应用 / 机器人 |
| `application:bot.menu:write` | 创建、更新、删除机器人菜单 | 应用 / 机器人 |
| `approval:approval:read` | 获取审批定义详情 | 用户 |
| `approval:instance:read` | 获取审批实例详情 | 用户 |
| `approval:instance:write` | 操作审批实例 | 用户 |
| `approval:task:read` | 获取任务基本信息 | 用户 |
| `approval:task:write` | 处理审批任务 | 用户 |
| `attendance:task:readonly` | 导出打卡数据 | 用户 |
| `base:app:copy` | 复制多维表格 | 应用 / 机器人、用户 |
| `base:app:create` | 创建多维表格 | 应用 / 机器人、用户 |
| `base:app:read` | 获取多维表格信息 | 应用 / 机器人、用户 |
| `base:app:update` | 更新多维表格 | 应用 / 机器人、用户 |
| `base:appmode:create` | 新建多维表格应用 | 应用 / 机器人、用户 |
| `base:appmode:read` | 查看多维表格应用 | 应用 / 机器人、用户 |
| `base:appmode_block:create` | 新建多维表格应用组件 | 应用 / 机器人、用户 |
| `base:appmode_block:read` | 查看多维表格应用组件 | 应用 / 机器人、用户 |
| `base:appmode_block:update` | 更新多维表格应用组件 | 应用 / 机器人、用户 |
| `base:appmode_page:create` | 新建多维表格应用页面 | 应用 / 机器人、用户 |
| `base:appmode_page:delete` | 删除多维表格应用页面 | 应用 / 机器人、用户 |
| `base:appmode_page:read` | 查看多维表格应用页面 | 应用 / 机器人、用户 |
| `base:appmode_page:update` | 更新多维表格应用页面 | 应用 / 机器人、用户 |
| `base:block:create` | 创建多维表格组件 | 应用 / 机器人、用户 |
| `base:block:delete` | 删除多维表格组件 | 应用 / 机器人、用户 |
| `base:block:read` | 读取多维表格组件 | 应用 / 机器人、用户 |
| `base:block:update` | 更新多维表格组件 | 应用 / 机器人、用户 |
| `base:dashboard:create` | 创建仪表盘 | 应用 / 机器人、用户 |
| `base:dashboard:delete` | 删除仪表盘 | 应用 / 机器人、用户 |
| `base:dashboard:read` | 获取仪表盘信息 | 应用 / 机器人、用户 |
| `base:dashboard:update` | 更新仪表盘 | 应用 / 机器人、用户 |
| `base:field:create` | 新增字段 | 应用 / 机器人、用户 |
| `base:field:delete` | 删除字段 | 应用 / 机器人、用户 |
| `base:field:read` | 获取字段信息 | 应用 / 机器人、用户 |
| `base:field:update` | 更新字段 | 应用 / 机器人、用户 |
| `base:form:create` | 创建表单问卷 | 应用 / 机器人、用户 |
| `base:form:delete` | 删除表单问卷 | 应用 / 机器人、用户 |
| `base:form:read` | 获取表单数据 | 应用 / 机器人、用户 |
| `base:form:update` | 更新表单数据 | 应用 / 机器人、用户 |
| `base:history:read` | 读取多维表格历史记录 | 应用 / 机器人、用户 |
| `base:record:create` | 新增记录 | 应用 / 机器人、用户 |
| `base:record:delete` | 删除记录 | 应用 / 机器人、用户 |
| `base:record:read` | 检索特定记录 | 应用 / 机器人、用户 |
| `base:record:update` | 更新记录 | 应用 / 机器人、用户 |
| `base:role:create` | 新增自定义角色 | 应用 / 机器人、用户 |
| `base:role:delete` | 删除自定义角色 | 应用 / 机器人、用户 |
| `base:role:read` | 查询自定义角色 | 应用 / 机器人、用户 |
| `base:role:update` | 更新自定义角色 | 应用 / 机器人、用户 |
| `base:table:create` | 新增数据表 | 应用 / 机器人、用户 |
| `base:table:delete` | 删除数据表 | 应用 / 机器人、用户 |
| `base:table:read` | 获取数据表信息 | 应用 / 机器人、用户 |
| `base:table:update` | 更新数据表 | 应用 / 机器人、用户 |
| `base:template:read` | 读取多维表格模板 | 应用 / 机器人、用户 |
| `base:view:read` | 检索视图 | 应用 / 机器人、用户 |
| `base:view:write_only` | 新增、更新、删除视图 | 应用 / 机器人、用户 |
| `base:workflow:create` | 创建自动化流程/工作流 | 应用 / 机器人、用户 |
| `base:workflow:read` | 查看自动化流程/工作流 | 应用 / 机器人、用户 |
| `base:workflow:update` | 更新自动化流程/工作流 | 应用 / 机器人、用户 |
| `base:workspace:create` | 新建多维表格空间 | 应用 / 机器人、用户 |
| `base:workspace:read` | 查看多维表格空间 | 应用 / 机器人、用户 |
| `base:workspace:update` | 更新多维表格空间 | 应用 / 机器人、用户 |
| `bitable:app` | 查看、评论、编辑和管理多维表格 | 应用 / 机器人 |
| `board:whiteboard:node:create` | 创建画板节点 | 应用 / 机器人、用户 |
| `board:whiteboard:node:read` | 查看画板节点 | 应用 / 机器人、用户 |
| `calendar:calendar.event:create` | 创建日程 | 用户 |
| `calendar:calendar.event:delete` | 删除日程 | 用户 |
| `calendar:calendar.event:join` | 加入日程 | 用户 |
| `calendar:calendar.event:read` | 读取日程信息 | 用户 |
| `calendar:calendar.event:reply` | 回复日程 | 用户 |
| `calendar:calendar.event:transfer` | 转让日程 | 用户 |
| `calendar:calendar.event:update` | 更新日程 | 用户 |
| `calendar:calendar.free_busy:read` | 读取日历忙闲信息 | 用户 |
| `calendar:calendar:create` | 创建日历 | 用户 |
| `calendar:calendar:delete` | 删除日历 | 用户 |
| `calendar:calendar:read` | 读取日历信息 | 用户 |
| `calendar:calendar:update` | 更新日历 | 用户 |
| `cardkit:card:read` | 获取卡片信息 | 应用 / 机器人 |
| `cardkit:card:write` | 创建与更新卡片 | 应用 / 机器人 |
| `contact:contact.base:readonly` | 获取通讯录基本信息 | 应用 / 机器人 |
| `contact:user.basic_profile:readonly` | 获取用户的基本信息 | 用户 |
| `contact:user:search` | 搜索用户 | 用户 |
| `docs:document.comment:create` | 添加、回复云文档中的评论 | 应用 / 机器人、用户 |
| `docs:document.comment:delete` | 删除云文档中的评论 | 应用 / 机器人、用户 |
| `docs:document.comment:read` | 获取云文档中的评论 | 应用 / 机器人、用户 |
| `docs:document.comment:update` | 修改云文档中的评论 | 应用 / 机器人、用户 |
| `docs:document.comment:write_only` | 回复、修改、删除云文档中的评论 | 应用 / 机器人、用户 |
| `docs:document.content:read` | 查看云文档内容 | 应用 / 机器人、用户 |
| `docs:document.media:download` | 下载云文档中的图片和附件 | 应用 / 机器人、用户 |
| `docs:document.media:upload` | 上传图片和附件到云文档中 | 应用 / 机器人、用户 |
| `docs:document:copy` | 复制云文档 | 应用 / 机器人、用户 |
| `docs:document:export` | 导出云文档 | 应用 / 机器人、用户 |
| `docs:document:import` | 查看、创建云文档导入任务 | 应用 / 机器人、用户 |
| `docs:permission.member:apply` | 申请云文档权限 | 用户 |
| `docs:permission.member:auth` | 判断当前用户是否有云文档权限 | 应用 / 机器人、用户 |
| `docs:permission.member:create` | 添加云文档协作者 | 应用 / 机器人、用户 |
| `docs:permission.member:delete` | 移除云文档协作者 | 应用 / 机器人、用户 |
| `docs:permission.member:retrieve` | 查看云文档的协作者列表 | 应用 / 机器人、用户 |
| `docs:permission.member:transfer` | 转移云文档的所有权 | 应用 / 机器人、用户 |
| `docs:permission.setting:read` | 查询云文档权限设置 | 应用 / 机器人、用户 |
| `docs:permission.setting:write_only` | 修改云文档权限设置 | 应用 / 机器人、用户 |
| `docs:secure_label:readonly` | 查看云文档密级标签 | 用户 |
| `docs:secure_label:write_only` | 修改文档密级 | 用户 |
| `docx:document` | 创建及编辑新版文档 | 应用 / 机器人、用户 |
| `docx:document.block:convert` | 转换文本为云文档块 | 应用 / 机器人 |
| `docx:document:create` | 创建新版文档 | 应用 / 机器人、用户 |
| `docx:document:readonly` | 查看新版文档 | 应用 / 机器人、用户 |
| `docx:document:write_only` | 编辑新版文档 | 应用 / 机器人、用户 |
| `drive:drive.metadata:readonly` | 查看云空间中文件元数据 | 应用 / 机器人、用户 |
| `drive:file:download` | 下载云空间下的文件 | 应用 / 机器人、用户 |
| `drive:file:upload` | 上传文件 | 应用 / 机器人、用户 |
| `drive:file:view_record:readonly` | 获取文档访问记录 | 应用 / 机器人、用户 |
| `drive:quota_detail:read_one` | 获取自身容量信息 | 用户 |
| `im:chat` | 获取与更新群组信息 | 应用 / 机器人 |
| `im:chat.managers:write_only` | 添加、删除群管理员 | 用户 |
| `im:chat.members:bot_access` | 订阅机器人进、出群事件 | 应用 / 机器人 |
| `im:chat.members:read` | 查看群成员 | 应用 / 机器人、用户 |
| `im:chat.members:write_only` | 添加、移除群成员 | 用户 |
| `im:chat.membership_application:read` | 获取入群申请信息 | 用户 |
| `im:chat.membership_application:write` | 审批入群申请 | 用户 |
| `im:chat.moderation:read` | 查看群发言权限 | 用户 |
| `im:chat.nickname:read` | 获取用户在群内的昵称 | 用户 |
| `im:chat.nickname:write` | 修改用户群内的昵称 | 用户 |
| `im:chat.user_setting:read` | 查看群内用户个人设置 | 用户 |
| `im:chat.user_setting:write` | 修改群内用户个人设置 | 用户 |
| `im:chat:create` | 创建群 | 应用 / 机器人 |
| `im:chat:create_by_user` | 以用户身份创建群 | 用户 |
| `im:chat:delete` | 解散群 | 应用 / 机器人、用户 |
| `im:chat:moderation:write_only` | 操作群发言权限 | 用户 |
| `im:chat:read` | 查看群信息 | 应用 / 机器人、用户 |
| `im:chat:update` | 更新群信息 | 应用 / 机器人、用户 |
| `im:feed.flag:read` | 获取标记数据 | 用户 |
| `im:feed.flag:write` | 创建、删除标记 | 用户 |
| `im:feed.shortcut:read` | 查看置顶 | 用户 |
| `im:feed.shortcut:write` | 创建、删除置顶 | 用户 |
| `im:feed_group_v1:read` | 获取标签相关数据 | 用户 |
| `im:feed_group_v1:write` | 创建、更新、删除标签相关数据 | 用户 |
| `im:message` | 获取与发送单聊、群组消息 | 用户 |
| `im:message.group_at_msg.include_bot:readonly` | 获取群组中其他机器人和用户@当前机器人的消息 | 应用 / 机器人 |
| `im:message.group_at_msg:readonly` | 获取群组中用户@机器人消息 | 应用 / 机器人 |
| `im:message.group_msg` | 获取群组中所有消息（敏感权限） | 应用 / 机器人 |
| `im:message.group_msg:get_as_user` | 以用户身份获取群聊消息 | 用户 |
| `im:message.p2p_msg:get_as_user` | 以用户身份获取单聊群消息 | 用户 |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | 应用 / 机器人 |
| `im:message.pins:read` | 查看 Pin 消息 | 应用 / 机器人、用户 |
| `im:message.pins:write_only` | 添加、 取消 Pin 消息 | 应用 / 机器人、用户 |
| `im:message.reactions:read` | 查看消息表情回复 | 应用 / 机器人、用户 |
| `im:message.reactions:write_only` | 发送、删除消息表情回复 | 应用 / 机器人、用户 |
| `im:message.send_as_user` | 以用户身份发送消息 | 用户 |
| `im:message:readonly` | 获取单聊、群组消息 | 应用 / 机器人、用户 |
| `im:message:recall` | 撤回消息 | 用户 |
| `im:message:send_as_bot` | 以应用的身份发消息 | 应用 / 机器人 |
| `im:message:send_multi_users` | 给多个用户批量发消息 | 应用 / 机器人 |
| `im:message:send_sys_msg` | 发送特定模板系统消息 | 应用 / 机器人 |
| `im:message:update` | 更新消息 | 应用 / 机器人、用户 |
| `im:resource` | 获取与上传图片或文件资源  | 应用 / 机器人、用户 |
| `mail:event` | 订阅邮箱相关事件 | 用户 |
| `mail:user_mailbox.event.mail_address:read` | 获取事件中的邮箱地址字段 | 用户 |
| `mail:user_mailbox.folder:read` | 查询邮箱文件夹 | 用户 |
| `mail:user_mailbox.folder:write` | 查看、创建、更新、删除邮箱文件夹 | 用户 |
| `mail:user_mailbox.mail_contact:read` | 查看邮箱联系人 | 用户 |
| `mail:user_mailbox.mail_contact:write` | 查看、创建、更新、删除邮箱联系人 | 用户 |
| `mail:user_mailbox.message.address:read` | 获取邮件内容中地址相关字段 | 用户 |
| `mail:user_mailbox.message.body:read` | 获取邮件正文 | 用户 |
| `mail:user_mailbox.message.subject:read` | 获取邮件主题 | 用户 |
| `mail:user_mailbox.message:modify` | 修改邮件 | 用户 |
| `mail:user_mailbox.message:readonly` | 查询用户邮件 | 用户 |
| `mail:user_mailbox.message:send` | 发送用户邮件 | 用户 |
| `mail:user_mailbox.rule:read` | 查看收信规则 | 用户 |
| `mail:user_mailbox.rule:write` | 查看、创建、更新、删除收信规则 | 用户 |
| `mail:user_mailbox:readonly` | 查询用户的企业邮箱 | 用户 |
| `mindnote:node:create` | 创建Mindnote节点 | 用户 |
| `mindnote:node:read` | 获取Mindnote节点 | 用户 |
| `minutes:minutes.artifacts:read` | 获取妙记 AI 产物 | 用户 |
| `minutes:minutes.basic:read` | 获取妙记的基本信息 | 用户 |
| `minutes:minutes.media:export` | 下载妙记的音视频文件 | 用户 |
| `minutes:minutes.search:read` | 搜索妙记 | 用户 |
| `minutes:minutes.upload:write` | 基于音视频文件生成妙记 | 用户 |
| `minutes:minutes:readonly` | 查看妙记文件 | 用户 |
| `minutes:minutes:update` | 更新妙记 | 用户 |
| `minutes:permission:apply` | 申请妙记权限 | 用户 |
| `offline_access` | 持续访问已授权的数据 | 用户 |
| `okr:okr.comment.delete` | 删除 OKR 评论 | 用户 |
| `okr:okr.comment.readonly` | 获取 OKR 评论 | 用户 |
| `okr:okr.comment.writeonly` | 更新 OKR 评论 | 用户 |
| `okr:okr.content:readonly` | 获取 OKR 内容 | 用户 |
| `okr:okr.content:writeonly` | 更新 OKR 内容 | 用户 |
| `okr:okr.period:readonly` | 获取 OKR 周期 | 用户 |
| `okr:okr.progress.file:upload` | 上传 OKR 进展图片附件 | 用户 |
| `okr:okr.progress:delete` | 删除 OKR 进展 | 用户 |
| `okr:okr.progress:readonly` | 获取 OKR 进展 | 用户 |
| `okr:okr.progress:writeonly` | 更新 OKR 进展 | 用户 |
| `okr:okr.setting:read` | 查看 OKR 设置 | 用户 |
| `profile:user_profile:read` | 查看用户的个性签名和状态 | 用户 |
| `report:task:readonly` | 查看汇报任务 | 用户 |
| `search:bot` | 搜索机器人 | 用户 |
| `search:docs:read` | 搜索云文档 | 用户 |
| `search:message` | 获取消息搜索结果 | 用户 |
| `sheets:spreadsheet` | 查看、评论、编辑和管理电子表格 | 应用 / 机器人 |
| `sheets:spreadsheet.meta:read` | 查询电子表格元信息 | 用户 |
| `sheets:spreadsheet.meta:write_only` | 修改电子表格元信息 | 用户 |
| `sheets:spreadsheet:create` | 创建电子表格 | 用户 |
| `sheets:spreadsheet:read` | 查看电子表格 | 用户 |
| `sheets:spreadsheet:write_only` | 编辑电子表格 | 用户 |
| `slides:presentation:create` | 创建幻灯片 | 用户 |
| `slides:presentation:read` | 查看幻灯片 | 用户 |
| `slides:presentation:screenshot` | 幻灯片截图 | 用户 |
| `slides:presentation:update` | 编辑幻灯片 | 用户 |
| `slides:presentation:write_only` | 创建及编辑幻灯片 | 用户 |
| `space:document:delete` | 删除云空间文件夹和云文档 | 应用 / 机器人、用户 |
| `space:document:move` | 移动云空间文件夹和云文档 | 应用 / 机器人、用户 |
| `space:document:retrieve` | 获取云空间文件夹下的云文档清单 | 用户 |
| `space:document:shortcut` | 创建云文档的快捷方式 | 应用 / 机器人、用户 |
| `space:folder:create` | 创建云空间文件夹 | 应用 / 机器人、用户 |
| `spark:app:read` | 获取妙搭应用信息 | 用户 |
| `spark:app:write` | 创建与更新妙搭应用 | 用户 |
| `spark:directory.user.id_convert:read` | 查看妙搭和飞书用户 ID 转换信息 | 用户 |
| `task:attachment:write` | 查看、创建、删除任务附件 | 用户 |
| `task:comment:write` | 查看、创建、更新、删除任务评论 | 用户 |
| `task:custom_field:read` | 查看自定义字段信息 | 用户 |
| `task:custom_field:write` | 查看、创建、更新自定义字段 | 用户 |
| `task:section:read` | 查看自定义分组 | 用户 |
| `task:section:write` | 查看、创建、更新、删除自定义分组 | 用户 |
| `task:task:read` | 查看任务信息 | 用户 |
| `task:task:write` | 查看、创建、更新、删除任务 | 用户 |
| `task:tasklist:read` | 查看任务清单 | 用户 |
| `task:tasklist:write` | 查看、创建、更新、删除任务清单 | 用户 |
| `vc:meeting.interaction:write` | 使用会中交互功能 | 用户 |
| `vc:meeting.meetingevent:read` | 获取会议信息 | 用户 |
| `vc:meeting.message:write` | 发送会中消息和表情 | 用户 |
| `vc:meeting.search:read` | 搜索视频会议 | 用户 |
| `vc:note:read` | 获取智能纪要 | 用户 |
| `vc:record:readonly` | 获取会议录制信息 | 用户 |
| `wiki:member:create` | 新增知识空间成员 | 用户 |
| `wiki:member:retrieve` | 查看知识空间成员列表 | 用户 |
| `wiki:member:update` | 更新知识空间成员 | 用户 |
| `wiki:node:copy` | 创建知识空间节点副本 | 用户 |
| `wiki:node:create` | 创建知识空间节点 | 用户 |
| `wiki:node:move` | 移动知识空间节点 | 用户 |
| `wiki:node:read` | 查看知识空间节点信息 | 应用 / 机器人、用户 |
| `wiki:node:retrieve` | 查看知识空间节点列表 | 应用 / 机器人、用户 |
| `wiki:space:read` | 查看知识空间信息 | 用户 |
| `wiki:space:retrieve` | 查看知识空间列表 | 用户 |
| `wiki:space:write_only` | 创建、更新知识空间 | 用户 |
| `wiki:wiki` | 查看、编辑和管理知识库 | 应用 / 机器人 |

<!-- feishu-permissions:end -->

## 应用配置与功能说明

桥接收发消息、建群、更新卡片和辅助群退群使用 **应用身份**（`tenant_access_token` / `--as bot`）。统一表中以“支持身份”字段标注身份；只给个人用户授权不能代替应用开通权限。

在 [飞书开发者后台](https://open.feishu.cn/app) 打开自己的应用：

1. 启用机器人能力，设置名称与头像。
2. 在权限管理中按统一表的 scope 标识搜索、添加，按租户要求申请审批。
3. 在“事件与回调”配置长连接、所需事件和卡片回调。
4. 设置应用可用范围，覆盖实际使用的自己与同事；仅勾选权限不等于用户都能使用。
5. 创建并发布应用版本；涉及审批时等待通过，再验证权限生效。
6. 将机器人加入目标群。辅助群还需由应用所有者在私聊完成会话关联。

桥接默认通过 WebSocket 长连接接收事件，无需为此架设公网回调服务。平台操作说明见 [长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)。

### 聊天、文件与卡片

桥接覆盖私聊控制台、个人 AI 群无需 @ 提问、辅助群 @ 提问、附件与流式卡片；对应权限全部收录在统一表，条件和可替代权限以接口文档为准。

`im:resource:upload` 是上传接口的另一种可选权限；本项目使用 `im:resource`，不要求两个都申请。更新消息卡片接口接受 `im:message:send_as_bot` 或 `im:message:update` 等权限之一；机器人发消息权限已能覆盖，无需为了卡片更新重复申请。

读取应用自身信息优先使用 `application:application:self_manage`，不要仅为识别所有者申请企业级的 `admin:app.info:readonly`。本项目使用 `open_id`，基础桥接不要求读取所有员工邮箱、手机号或申请全量通讯录。

### 个人工作群（含 AA 会话群）与辅助群

启用个人工作群与辅助群生命周期时，需要具备建群、更新群信息、解散群、读取成员及机器人入群和退出等权限。

机器人将群主转交给人类后，继续管理其创建的群仍需相应管理权限；成员核验依赖群成员读取权限。

当前应用的 `im:chat.members:write_only` 仅返回用户身份，机器人群管理还具有较宽的 `im:chat` 应用权限。其他应用应按对应接口核对 bot 身份支持的替代权限，不能将用户 scope 当成机器人授权。

群管理权限不能代替群内角色校验，不能管理旧机器人或他人创建的任意群。本版“归档”保留群，“归档并解散群”还需要 `im:chat:delete`。新群由机器人担任群主；旧群能否解散仍受实际群主 / 管理权限限制。见 [群成员列表](https://open.feishu.cn/document/server-docs/group/chat-member/get)。

### 所有者的消息免打扰（用户身份）

新建个人工作群（含 AA 工作群）或 AI助手私聊群时，桥接通过主 `lark-cli` 为当前应用所有者设置 `is_muted=true`。这是所有者自己的普通消息通知偏好，不修改其他成员或 `@所有人` 的提醒设置，也不改变机器人是否处理消息。仅在建群时应用，不会定期覆盖用户之后的手动修改。

启用辅助群的会话共享不改动群通知设置：辅助群通常是所有者已参与的协作群，同事 @机器人 提问时需要正常提醒。历史版本曾在此处免打扰，升级后不会自动恢复，需要时由所有者手动开启通知。

主 CLI 需绑定同一个应用、以该应用所有者登录，并完成用户身份的群设置写权限授权；群设置读权限用于迁移和读回验证。

桥接先核对应用 ID 和当前所有者的 `open_id`，匹配后才以 `--as user` 调用 `im chat.user_setting batch_update`。只使用主 CLI 的已有授权，不读取或传递用户 token，不放开 Agent 专用 CLI 的 bot 身份限制。主 CLI 使用标准配置目录；自定义目录可为桥接设置 `LARK_CHANNEL_OWNER_CLI_CONFIG_DIR`。未登录、身份不符、缺权限或用户不在群内时仅记录警告，不阻断建群或关联，也不自动发起授权。

### 群消息、引用历史与表情提示

`im:message.group_msg` 是敏感权限，不是仅接收用户 @ 的必要条件。但 [按 ID 获取群消息](https://open.feishu.cn/document/server-docs/im-v1/message/get) 的应用身份调用在基础读消息权限之外还要求全部群消息权限；如果需要引用、话题补全或 CLI 读取历史，应一并申请。资源下载有自己的权限要求，不要把两者混淆。

辅助群的入口始终要求真实 @ 人类消息。即使申请了全部群消息权限，辅助群也不会因此开始响应普通闲聊；已绑定个人 AI 群在程序中豁免艾特要求，默认配置同样适用；未绑定普通群才受 `requireMentionInGroup` 配置限制。当前只处理人类提问，无需为此申请接收其他机器人消息的权限。接收规则见 [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。

## 事件与回调

权限授权与事件订阅是两个步骤；只申请 scope 不会自动把事件推到桥接。

| 事件 / 回调标识 | 必要性 | 用途 |
| --- | --- | --- |
| `im.message.receive_v1` | 必需 | 接收私聊和群消息；消息范围由已授权 scope 决定 |
| `card.action.trigger` | 必需的卡片回调 | 控制台、关联选择、停止、刷新和选项表单 |
| `im.chat.member.bot.added_v1` | 辅助群的会话共享设置必需 | 机器人被添加到群后通知所有者 |
| `im.message.reaction.created_v1` | 按需 | SDK 支持的新增表情事件 |
| `im.message.reaction.deleted_v1` | 按需 | SDK 支持的删除表情事件 |
| `drive.notice.comment_add_v1` | 仅云文档评论功能 | 文档评论中 @ 机器人 |

在后台分别检查事件配置与回调配置，并使用长连接模式。卡片折叠 / 展开本身由飞书客户端处理，不需要新增业务权限或自定义按钮回调。

平台也有机器人被移出群事件，但当前 channel SDK 的桥接接入只暴露 `botAdded`，不能仅靠后台勾选事件就宣称已实现被动退群自动归档。桥接另在启动时及每分钟通过 `im.v1.chat.get` 分批检查关联群（每批最多 50 个），明确确认群已解散后清理本地路由；使用既有群信息读取权限，不需要解散群权限。机器人被移出、权限不足或查询失败时保留关联，不冒充群已解散。原生会话历史及其他关联群保留，详见 [群清理机制](CODEX_TASK_LIFECYCLE.md#dissolved-groups-lose-their-live-bridge-routes)。

### 云文档与个人资源

只做群内编程问答和传文件，不需要顺便申请日历、邮件、审批、考勤或整个云盘权限。

- **云文档评论**：按实际调用申请 `docs:document.comment:read` 及 `docs:document.comment:create` / `docs:document.comment:write_only` 等相应权限，再订阅评论事件并开放目标文档访问。还需读取正文或修改文档时，按对应文档类型补权限。[读评论](https://open.feishu.cn/document/server-docs/docs/CommentAPI/list)、[写评论](https://open.feishu.cn/document/server-docs/docs/CommentAPI/create)。
- **个人日历、云盘、邮箱等**：按具体 `lark-cli` 功能申请用户身份 scope，再由实际用户授权；应用身份授权不能代替用户授权，也不能绕过目标资源的共享 / 数据范围。
- **普通桥接默认 bot-only**：使用 profile 隔离的 CLI 配置。需要用户身份时按管理员策略切换；不要把自己的用户登录目录直接共享给所有部署者。

## 发布后的验收

1. **私聊**：所有者发“新建会话”，应收到控制台卡片，按钮能触发操作。
2. **个人工作群**：创建一个测试群，所有者及另一名成员分别不 @ 直接提问，检查流式回复和刷新；若只能 @ 才回复，先检查 `im:message.group_msg` 是否审批并发布生效。
3. **会话共享**：由所有者拉机器人进测试群，收到私聊关联卡片；选择来源会话后在群内 @ 提问。
4. **文件**：发送小图片 / 文件供机器人读取，再要求把一个允许发送的脚本发回本群；以真实附件消息为成功依据。
5. **折叠**：最新辅助群回复完整显示；新回复成功发送后，超过 1000 字的旧回复才折叠，展开可见完整内容、状态和按钮。
6. **主动退出**：在专用测试辅助群内由所有者真实 @ 发送“退出”，确认机器人离群；不是解散整个群。

另在专用个人测试群验证“归档并解散群”；文档评论等功能按需测试。不要通过无关群的管理操作来测试权限。

## 常见问题

| 现象 | 先检查 |
| --- | --- |
| 个人 AI 群必须 @ 才回复 | 应用身份 `im:message.group_msg`、审批 / 发布生效及是否确实绑定个人 AI 会话；只改配置无法让飞书推送缺失的消息 |
| 有私聊无群回复 | 群 @ 消息权限、消息事件、真实 @、机器人在群和应用可用范围 |
| 有回复但无按钮效果 | `card.action.trigger` 回调、长连接、真实操作人的访问权限 |
| 入群没有私聊关联卡片 | `im:chat.members:bot_access`、机器人进群事件、邀请者是否应用所有者；私聊 `/aux` 查看待关联 |
| 读消息 / 引用失败 | 基础读消息权限，以及群内场景是否额外需要 `im:message.group_msg` |
| 能发文字但无法流式更新 | `cardkit:card:write`、CardKit 接口业务错误和卡片大小 |
| `99991672` / `99991679` | 检查返回的缺失 scope、调用身份与已发布版本；不要把 HTTP 400 一概视作参数错误 |
| `232017` | 群主 / 群创建者等管理身份及 `im:chat:operate_as_owner`，不只是 scope 是否勾选 |
| 应用能用，但同事找不到 | 应用可用范围、发布 / 审批状态及桥接访问控制 |

本仓库已修复辅助群关联时使用旧 `members/is_in_chat` 导致的 400：现在用 `chat.get` 和 `im:chat:read` 校验机器人在群内，不必为该旧接口额外申请一组旧权限。进群事件仍需要单独的事件权限与订阅。

新申请按接口选择细粒度 scope。旧应用若已有 `im:chat`、`im:message` 等较宽权限，不必仅为匹配本文重复申请；具体接口通常列有多个可替代 scope，需分别核对。迁移时逐项验证后再移除旧权限。

## AI助手私聊群

成员在已关联辅助群中 `@机器人 私聊`，复用现有建群接口，创建包含请求者、应用所有者和机器人的私有群。桥接应用需要 `im:chat:create`、`im:chat:read`、`im:chat.members:read`，以及现有群 @ 消息接收和机器人发送权限。创建群时通过 `user_id_list` 邀请成员，不额外调用加人接口；退出仍使用 `im:chat.members:write_only`。应用可用范围须包含相关成员及所有者；平台权限需实际发布生效。

创建前核验请求者仍是来源群成员，创建后或复用已有私聊群时核验成员完整；查询失败不按群 ID 直接放行。旧 `ff-dm-v1`、`/ff` 私聊问答已停用，同事无需为此配置机器人搜索或额外用户 CLI 授权。其他 agent 若通过飞书群发送消息，仍须使用各自真实用户身份及相应群消息权限；也可使用独立的 A2A 接口。

## 会话共享的受限操作确认

确认使用现有机器人消息与 CardKit 交互能力：发送机器人消息、`cardkit:card:write`、`card.action.trigger` 回调，以及识别应用所有者的应用信息权限。辅助群及私聊群的卡片使用真实所有者 open_id 的 @；A2A API 调用的确认卡发到所有者私聊。无需另申请原生飞书审批权限。确认只能对会话共享提示词规则中的具体操作放宽，平台缺失 scope、账号授权或系统文件权限仍需实际开通。

## 维护者：从参考机器人刷新申请清单

本节仅供仓库维护者更新安装申请清单。以已配置完整权限的参考机器人作为来源，在仓库根目录执行：

```bash
node tools/update-feishu-permissions.mjs
```

脚本先通过 `lark-cli whoami --as bot` 确定当前应用，再以机器人身份调用[获取应用信息](https://open.feishu.cn/document/server-docs/application-v6/application/get)，读取全部 `scopes`，去重、排序并刷新统一表。只修改自动生成区域，保留配置说明；查询失败、身份不匹配或返回不完整时保留原清单。需要已开通并发布 `application:application:self_manage`。

显式指定应用，或只读检查清单是否最新：

```bash
node tools/update-feishu-permissions.mjs --profile cli_aa36351590381bcd
node tools/update-feishu-permissions.mjs --check
```

`--profile` 是 **lark-cli 配置名**，不是桥接的 `lennox-codex` 等 profile，不会切换全局配置。省略时沿用当前 CLI 配置和 `LARKSUITE_CLI_CONFIG_DIR` 环境。可先执行 `lark-cli whoami --as bot` 核对 App ID。`--check` 不修改文件，有变化时退出码为 1。

也可将 `<AppID>` 替换为当前应用 ID，直接读取原始数据：

```bash
lark-cli api GET /open-apis/application/v6/applications/<AppID> \
  --as bot --params '{"lang":"zh_cn","user_id_type":"open_id"}' \
  --jq '.data.app | {app_id,app_name,scopes}'
```

当前安装版本的 `lark-cli auth scopes --json` 只返回 `userScopes`，不能作为全部权限来源。`auth status` 是用户登录和授权状态，也不能代替应用完整清单。

表内“应用 / 机器人”对应 `tenant_access_token`，“用户”对应 `user_access_token`。应用已开通用户身份 scope 不代表具体用户已经完成 OAuth；权限清单也不代替资源共享、数据范围、审批及发布状态。刷新命令只读应用信息并更新本地文档，不开通权限、不发起 OAuth。参考机器人权限变更后，维护者可重新读取并提交清单。不要以新安装、尚未申请权限的空应用覆盖这份参考清单。
