import type { LarkChannel } from '@larksuite/channel';

export interface PrivateFFInput {
  protocol: 'ff-dm-v1';
  bot_app_id: string;
  group_id: string;
  binding_id: string;
  request_id: string;
  action?: 'ask' | 'stop' | 'refresh';
  question?: string;
}

/** Only explicit protocol messages bypass the ordinary DM console. */
export function parsePrivateFFInput(text: string): PrivateFFInput | undefined {
  const trimmed = text.trim();
  const explicit = trimmed.startsWith('/ff ');
  let value: unknown;
  try { value = JSON.parse(explicit ? trimmed.slice(4) : trimmed); }
  catch { if (explicit) throw new Error('/ff 后需要完整的 ff-dm-v1 JSON 请求。'); return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as PrivateFFInput;
  if (input.protocol !== 'ff-dm-v1') { if (explicit) throw new Error('不支持的 FF 协议。'); return; }
  for (const key of ['bot_app_id', 'group_id', 'binding_id', 'request_id'] as const) {
    if (typeof input[key] !== 'string' || !/^[\w-]{1,120}$/.test(input[key])) throw new Error(`FF 请求缺少有效的 ${key}。`);
  }
  if (input.action !== undefined && !['ask', 'stop', 'refresh'].includes(input.action)) throw new Error('FF action 仅支持 ask、stop、refresh。');
  if ((!input.action || input.action === 'ask') && (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 50_000))
    throw new Error('FF 请求需要非空 question（最多 50000 字符）。');
  return input;
}

export function auxiliarySessionName(name: string): string {
  const title = name.trimStart();
  return title.startsWith('AA') ? `FF${title.slice(2)}` : `FF-${name}`;
}

/** IDs are returned under this bot's app identity, matching received sender IDs. */
export async function auxiliaryUserIsMember(channel: LarkChannel, chatId: string, actorId: string): Promise<boolean> {
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await channel.rawClient.im.v1.chatMembers.get({ path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } });
    if (result.code || !result.data) throw new Error(`无法核验群成员（${result.code ?? '缺少数据'}），请检查 im:chat.members:read 权限。`);
    if (result.data.items?.some(item => item.member_id === actorId)) return true;
    if (!result.data.has_more) return false;
    pageToken = result.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error('群成员分页不完整，暂不允许私聊调用。');
    seen.add(pageToken);
  } while (pageToken);
  return false;
}

export function privateFFAnnouncement(appId: string, groupId: string, bindingId: string, name: string, botName = '本群机器人'): string {
  const example = JSON.stringify({ protocol: 'ff-dm-v1', bot_app_id: appId, group_id: groupId,
    binding_id: bindingId, request_id: '<每次问题生成唯一编号>', action: 'ask', question: '<我的问题>' }, null, 2);
  return `「${name}」已开放机器人私聊问答。复制以下内容给你的 agent：\n\n` +
    `请通过飞书 CLI，以我本人的用户身份私聊「${botName}」（app_id=${appId}）。\n` +
    `先用 contact +search-bot，--as user，--query 使用机器人名称，--chat-ids 使用 ${groupId}，解析当前用户可用的机器人 open_id 和私聊 chat_id。多条候选时先确认目标，不自动选第一条。不要复用其他应用的 open_id。\n` +
    '发送使用 im +messages-send --as user，目标为搜索结果的私聊 --chat-id，或机器人的 --user-id；用 --content - 从 stdin 传入 {"text":"完整 JSON 请求"}。读取使用 im +chat-messages-list --as user，从返回的私聊 chat_id 获取最新回复。group_id 仅定位来源，绝不能作为发送目标。\n' +
    `每次私聊发送一条完整 JSON：\n${example}\n\n` +
    '在同一私聊中读取带有对应 request_id 的回答；回复到原请求的卡片为结果，卡片更新为完成后再继续。' +
    '需要停止或刷新时，保留全部入口字段及原 request_id，将 action 改为 stop 或 refresh。超时先查询原私聊，不要换编号自动重试。' +
    '不要向群里发送问题、调试过程或结果。若未安装飞书 CLI 或未登录，请先引导我完成配置和用户授权。\n\n' +
    '仅本群当前成员可以调用，权限与群内提问一致。私聊与群内共用 FF 上下文；调试消息不显示在群内，但会进入共享历史。';
}
