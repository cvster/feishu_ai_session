import type { LarkChannel } from '@larksuite/channel';
import type { AgentKind } from '../config/profile-schema';
import { GROUP_AVATAR_IMAGES } from './group-avatar-images';

// Feishu image keys belong to the uploading app. Each channel owns its cache;
// account changes create a new channel, and simultaneous group creation shares uploads.
const uploads = new WeakMap<LarkChannel, Map<AgentKind, Promise<string>>>();

export async function sessionGroupAvatar(channel: LarkChannel, toolId: AgentKind): Promise<string | undefined> {
  if (!(toolId in GROUP_AVATAR_IMAGES)) return undefined;
  const image = GROUP_AVATAR_IMAGES[toolId as keyof typeof GROUP_AVATAR_IMAGES];
  if (!image || !channel.rawClient.im?.v1?.image?.create) return undefined;
  let cache = uploads.get(channel);
  if (!cache) { cache = new Map(); uploads.set(channel, cache); }
  let pending = cache.get(toolId);
  if (!pending) {
    pending = (async () => {
      const response = await channel.rawClient.im.v1.image.create({
        data: { image_type: 'avatar', image: Buffer.from(image, 'base64') },
      });
      const key = response?.image_key;
      if (!key?.trim()) throw new Error('Group avatar upload returned no image key');
      return key;
    })();
    cache.set(toolId, pending);
  }
  try { return await pending; }
  catch (error) {
    if (cache.get(toolId) === pending) cache.delete(toolId);
    throw error;
  }
}

// Backfill existing personal groups once per channel; failed uploads/updates retry on the next sync.
const repairs = new WeakMap<LarkChannel, Map<string, Promise<void>>>();
export async function ensureSessionGroupAvatar(channel: LarkChannel, toolId: AgentKind, chatId: string): Promise<void> {
  if (!channel.rawClient.im?.v1?.image?.create || !channel.rawClient.im?.v1?.chat?.update) return;
  let cache = repairs.get(channel);
  if (!cache) { cache = new Map(); repairs.set(channel, cache); }
  const key = JSON.stringify([toolId, chatId]);
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const avatar = await sessionGroupAvatar(channel, toolId);
      if (!avatar) return;
      const response = await channel.rawClient.im.v1.chat.update({ path: { chat_id: chatId }, data: { avatar } });
      if (response.code) throw new Error(`Feishu avatar update failed (${response.code})`);
    })();
    cache.set(key, pending);
  }
  try { await pending; } catch (error) { if (cache.get(key) === pending) cache.delete(key); throw error; }
}
