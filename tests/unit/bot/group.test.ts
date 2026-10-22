import { describe, expect, it, vi } from 'vitest';
import { defaultChatName, describeChatDeletionError, dissolveChat, isDefaultChatName } from '../../../src/bot/group.js';

describe('group chat helpers', () => {
  it('explains the missing creator-management permission for a 232017 failure', () => {
    const message = describeChatDeletionError({ response: { data: { code: 232017, msg: 'no permission' } } });
    expect(message).toContain('im:chat:operate_as_owner');
    expect(message).toContain('发布新版本');
    expect(message).toContain('群主手动解散');
  });

  it.each([false, true])('accepts already-dissolved responses for idempotent deletion (throws: %s)', async throws => {
    const remove = vi.fn();
    if (throws) remove.mockRejectedValue({ response: { data: { code: 232009 } } });
    else remove.mockResolvedValue({ code: 232009 });
    const channel = { rawClient: { im: { v1: { chat: { delete: remove } } } } } as never;
    await expect(dissolveChat(channel, 'oc_gone')).resolves.toBeUndefined();
  });

  it('preserves SDK response codes when deletion is rejected', async () => {
    const channel = { rawClient: { im: { v1: { chat: { delete: vi.fn(async () => ({ code: 232017, msg: 'No permission' })) } } } } } as never;
    await expect(dissolveChat(channel, 'oc_old')).rejects.toMatchObject({ code: 232017, msg: 'No permission' });
  });

  it('retains useful non-permission failure details', () => {
    expect(describeChatDeletionError(new Error('timeout'))).toBe('timeout');
    expect(describeChatDeletionError({ response: { data: { code: 232011, msg: 'Bot is not in chat' } } }))
      .toBe('Bot is not in chat（232011）');
  });

  it('starts default group names at Codex任务1', () => {
    expect(defaultChatName()).toBe('Codex任务1');
  });

  it('uses the first available numeric suffix', () => {
    expect(defaultChatName(['Codex任务1', 'Codex任务2', '其他群'])).toBe('Codex任务3');
    expect(defaultChatName(['Codex任务1', 'Codex任务3'])).toBe('Codex任务2');
  });

  it('recognizes generated default names', () => {
    expect(isDefaultChatName('Codex任务12')).toBe(true);
    expect(isDefaultChatName('Codex任务')).toBe(false);
    expect(isDefaultChatName('Codez任务1')).toBe(false);
  });
});
