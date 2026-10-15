import type { LarkChannel } from '@larksuite/channel';
import type { AgentKind } from '../config/profile-schema';
import { GROUP_AVATAR_IMAGES } from './group-avatar-images';

// Feishu image keys belong to the uploading app. Each channel owns its cache;
// account changes create a new channel, and simultaneous group creation shares uploads.
const uploads = new WeakMap<LarkChannel, Map<AgentKind, Promise<string>>>();

export async function sessionGroupAvatar(channel: LarkChannel, toolId: AgentKind): Promise<string | undefined> {
  if (!channel.rawClient.im?.v1?.image?.create) return undefined;
  let cache = uploads.get(channel);
  if (!cache) { cache = new Map(); uploads.set(channel, cache); }
  let pending = cache.get(toolId);
  if (!pending) {
    pending = (async () => {
      const response = await channel.rawClient.im.v1.image.create({
        data: { image_type: 'avatar', image: Buffer.from(GROUP_AVATAR_IMAGES[toolId], 'base64') },
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
