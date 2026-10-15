import type { LarkChannel } from '@larksuite/channel';

/** chat.get supports the current im:chat:read scope; legacy is_in_chat does not. */
export async function auxiliaryBotIsMember(channel: LarkChannel, chatId: string): Promise<boolean> {
  let response;
  try { response = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } }); }
  catch (error) {
    const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (code === 232011 || code === 232009) return false;
    throw error;
  }
  if (response.code === 232011 || response.code === 232009) return false;
  if (response.code) throw new Error(`群信息查询失败（${response.code}）`);
  if (!response.data) throw new Error('群信息查询未返回数据，请稍后重试。');
  if (response.data.chat_status && response.data.chat_status !== 'normal') return false;
  // Outside a chat, chat.get only returns name/avatar/member counts/status.
  // Never treat that partial public response as proof of membership.
  return response.data.chat_mode === 'group' || response.data.chat_mode === 'topic';
}

export function auxiliaryLinkError(error: unknown): string {
  const data = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (data?.code === 99991672 || data?.code === 99991679) return `飞书接口权限不足（${data.code}），请检查应用已发布的权限。`;
  if (data?.code) return `飞书接口返回错误 ${data.code}。请稍后重试，或联系所有者检查应用配置。`;
  return error instanceof Error ? error.message : '请求未完成，请稍后重试。';
}
