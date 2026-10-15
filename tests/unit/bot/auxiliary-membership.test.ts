import { expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { auxiliaryBotIsMember, auxiliaryLinkError } from '../../../src/bot/auxiliary-membership';
function channel(response: object) {
  const get = vi.fn(async () => response);
  const isInChat = vi.fn(async () => { throw { response: { data: { code: 99991672 } } }; });
  return { client: { rawClient: { im: { v1: { chat: { get }, chatMembers: { isInChat } } } } } as unknown as LarkChannel, get, isInChat };
}
it('checks full group details without requiring the legacy membership scopes that caused HTTP 400', async () => {
  const h = channel({ code: 0, data: { chat_mode: 'group', chat_status: 'normal' } });
  expect(await auxiliaryBotIsMember(h.client, 'oc_group')).toBe(true);
  expect(h.isInChat).not.toHaveBeenCalled();
});
it.each([{ name: 'public name', user_count: '4' }, { chat_mode: 'group', chat_status: 'dissolved' }])('does not grant membership from partial/outdated details: %j', async data => {
  expect(await auxiliaryBotIsMember(channel({ code: 0, data }).client, 'oc_group')).toBe(false);
});
it('treats confirmed removal as absent but propagates permission/transport failures', async () => {
  const h = channel({}); h.get.mockRejectedValueOnce({ response: { data: { code: 232011 } } });
  expect(await auxiliaryBotIsMember(h.client, 'oc_group')).toBe(false);
  const denied = { response: { data: { code: 99991672 } } }; h.get.mockRejectedValueOnce(denied);
  await expect(auxiliaryBotIsMember(h.client, 'oc_group')).rejects.toBe(denied);
  h.get.mockRejectedValueOnce(new Error('timeout'));
  await expect(auxiliaryBotIsMember(h.client, 'oc_group')).rejects.toThrow('timeout');
});
it('shows an actionable business error without leaking axios headers, tokens or URLs', () => {
  expect(auxiliaryLinkError({ response: { data: { code: 99991672, msg: 'secret url https://secret' } } })).toBe('飞书接口权限不足（99991672），请检查应用已发布的权限。');
  expect(auxiliaryLinkError({ response: { data: { code: 200001 } } })).toContain('200001');
});
