import { describe, expect, it, vi } from 'vitest';
import { configureGroupNotifications, muteSessionGroup } from '../../../src/bot/group-notifications';
import { createBoundChat } from '../../../src/bot/group';

function setup() {
  let owner: string | undefined = 'ou_owner';
  const auth = { appId: 'cli_current', identities: { user: { available: true, openId: 'ou_owner' } } };
  const result = { ok: true, identity: 'user', data: { invalid_ids: [] } };
  const run = vi.fn(async (args: string[], _data?: unknown): Promise<unknown> => args[0] === 'auth' ? auth : result);
  const create = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_new' } }));
  const channel = { rawClient: { im: { v1: { chat: { create } } } } } as never;
  configureGroupNotifications(channel, { appId: 'cli_current', ownerId: () => owner }, run);
  return { channel, run, auth, result, create, setOwner: (value: string | undefined) => { owner = value; } };
}

describe('owner session-group notifications', () => {
  it('mutes new workgroups as the verified owner without changing @all preferences', async () => {
    const h = setup();
    await expect(createBoundChat({ channel: h.channel, name: 'AA-task', inviteOpenId: 'ou_owner' }))
      .resolves.toEqual({ chatId: 'oc_new', name: 'AA-task' });
    expect(h.run).toHaveBeenLastCalledWith(
      ['im', 'chat.user_setting', 'batch_update', '--as', 'user', '--data', '-'],
      { chat_settings: [{ chat_id: 'oc_new', is_muted: true }] },
    );
  });

  it('shares in-flight calls and does not reapply after a later manual notification change', async () => {
    const h = setup();
    await Promise.all([muteSessionGroup(h.channel, 'oc_ff'), muteSessionGroup(h.channel, 'oc_ff')]);
    await muteSessionGroup(h.channel, 'oc_ff');
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it.each(['app', 'user', 'unavailable', 'owner-unavailable', 'owner-changed'])(
    'never writes notification settings for an unverified identity (%s)', async failure => {
      const h = setup();
      if (failure === 'app') h.auth.appId = 'cli_other';
      if (failure === 'user') h.auth.identities.user.openId = 'ou_other';
      if (failure === 'unavailable') h.auth.identities.user.available = false;
      if (failure === 'owner-unavailable') h.setOwner(undefined);
      if (failure === 'owner-changed') h.run.mockImplementationOnce(async () => { h.setOwner('ou_changed'); return h.auth; });
      await muteSessionGroup(h.channel, 'oc_ff');
      expect(h.run.mock.calls.every(([args]) => args[0] === 'auth')).toBe(true);
    },
  );

  it.each([
    { ok: false },
    { ok: true, identity: 'bot', data: {} },
    { ok: true, identity: 'user' },
    { ok: true, identity: 'user', data: { invalid_ids: [{ id: 'oc_new', msg: 'not_a_member' }] } },
    { ok: true, identity: 'user', data: { invalid_ids: 'invalid' } },
  ])('does not fail successful creation on mute failure, and allows a later retry: %j', async response => {
    const h = setup();
    h.run.mockImplementationOnce(async () => h.auth).mockImplementationOnce(async () => response);
    await expect(createBoundChat({ channel: h.channel, name: 'FF-task', inviteOpenId: 'ou_owner' }))
      .resolves.toMatchObject({ chatId: 'oc_new' });
    await muteSessionGroup(h.channel, 'oc_new');
    expect(h.run).toHaveBeenCalledTimes(4);
  });

  it('does not mute a nonexistent chat after creation fails', async () => {
    const h = setup();
    h.create.mockRejectedValueOnce(new Error('creation failed'));
    await expect(createBoundChat({ channel: h.channel, name: 'AA-task', inviteOpenId: 'ou_owner' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('isolates channels and treats unavailable owner CLI as an optional failure', async () => {
    const a = setup(), b = setup();
    a.run.mockRejectedValueOnce(new Error('owner CLI unavailable'));
    await muteSessionGroup(a.channel, 'oc_ff');
    await muteSessionGroup(b.channel, 'oc_ff');
    expect(b.run).toHaveBeenCalledTimes(2);
    await muteSessionGroup(a.channel, 'oc_ff');
    expect(a.run).toHaveBeenCalledTimes(3);
  });
});
