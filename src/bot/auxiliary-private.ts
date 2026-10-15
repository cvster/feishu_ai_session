import type { LarkChannel } from '@larksuite/channel';

/** Recognize retired input only to show a migration notice, never route or execute it. */
export function isRetiredPrivateInput(text: string): boolean {
  const value = text.trim();
  if (/^\/ff(?:\s|$)/.test(value)) return true;
  try { return JSON.parse(value)?.protocol === 'ff-dm-v1'; } catch { return false; }
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
    if (!pageToken || seen.has(pageToken)) throw new Error('群成员分页不完整，暂不允许创建私聊群。');
    seen.add(pageToken);
  } while (pageToken);
  return false;
}
