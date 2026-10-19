import { describe, expect, it, vi } from 'vitest';
import { createBoundChat } from '../../../src/bot/group';
import { sessionGroupAvatar, ensureSessionGroupAvatar } from '../../../src/bot/group-avatar';
import { GROUP_AVATAR_IMAGES } from '../../../src/bot/group-avatar-images';
import { readFileSync } from 'node:fs';

function channel() {
  const image = vi.fn(async (_params: unknown) => ({ image_key: 'img_avatar' }));
  const create = vi.fn(async (_params: unknown) => ({ code: 0, data: { chat_id: 'oc_created' } }));
  const update = vi.fn(async (_params: unknown) => ({ code: 0 }));
  const api = { rawClient: { im: { v1: { image: { create: image }, chat: { create, update } } } } };
  return { api: api as never, image, create, update };
}

describe('session group avatars', () => {
  it('embeds the opaque RGB Kilo asset so white/transparent extension icons cannot disappear on white', () => {
    const png = Buffer.from(GROUP_AVATAR_IMAGES.kilo!, 'base64');
    expect(png).toEqual(readFileSync(new URL('../../../assets/session-avatars/kilo.png', import.meta.url)));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
    expect(png[25]).toBe(2); // RGB, no alpha channel or palette transparency.
    const chunks: string[] = [];
    for (let at = 8; at + 12 <= png.length; at += png.readUInt32BE(at) + 12)
      chunks.push(png.toString('ascii', at + 4, at + 8));
    expect(chunks).not.toContain('tRNS');
  });
  it.each(['codex', 'claude', 'zcode', 'kilo'] as const)('uses the bound %s tool for the group avatar', async toolId => {
    const h = channel();
    await createBoundChat({ channel: h.api, name: 'AA same name', toolId, inviteOpenId: 'ou_owner' });
    expect(h.image).toHaveBeenCalledWith({ data: { image_type: 'avatar',
      image: Buffer.from(GROUP_AVATAR_IMAGES[toolId], 'base64') } });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      name: 'AA same name', avatar: 'img_avatar', owner_id: 'ou_owner',
    }) }));
  });

  it('shares concurrent uploads per tool and isolates application channels', async () => {
    const a = channel(), b = channel();
    await Promise.all([sessionGroupAvatar(a.api, 'codex'), sessionGroupAvatar(a.api, 'codex')]);
    expect(a.image).toHaveBeenCalledTimes(1);
    await sessionGroupAvatar(a.api, 'claude');
    expect(a.image).toHaveBeenCalledTimes(2);
    await sessionGroupAvatar(b.api, 'codex');
    expect(b.image).toHaveBeenCalledTimes(1);
  });

  it('continues group creation after upload failure and retries the next time', async () => {
    const h = channel();
    h.image.mockRejectedValueOnce(new Error('missing im:resource'));
    await expect(createBoundChat({ channel: h.api, name: 'AA task', toolId: 'claude', inviteOpenId: 'ou_owner' }))
      .resolves.toMatchObject({ chatId: 'oc_created' });
    expect(h.create.mock.calls[0]?.[0]).not.toHaveProperty('data.avatar');
    await sessionGroupAvatar(h.api, 'claude');
    expect(h.image).toHaveBeenCalledTimes(2);
  });
});

it('repairs an existing group once, retries failures, and uses the original tool image', async () => {
  const h = channel();
  h.update.mockRejectedValueOnce(new Error('temporary failure'));
  await expect(ensureSessionGroupAvatar(h.api, 'zcode', 'oc_old')).rejects.toThrow('temporary failure');
  await Promise.all([ensureSessionGroupAvatar(h.api, 'zcode', 'oc_old'), ensureSessionGroupAvatar(h.api, 'zcode', 'oc_old')]);
  await ensureSessionGroupAvatar(h.api, 'zcode', 'oc_old');
  expect(h.update).toHaveBeenCalledTimes(2); expect(h.image).toHaveBeenCalledTimes(1);
  expect(h.update).toHaveBeenLastCalledWith({ path: { chat_id: 'oc_old' }, data: { avatar: 'img_avatar' } });
  expect(Object.keys(GROUP_AVATAR_IMAGES).sort()).toEqual(['claude', 'codex', 'kilo', 'zcode']);
});
