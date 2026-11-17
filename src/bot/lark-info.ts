import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export interface KnownChat {
  id: string;
  name: string;
}

export type KnownChatsFetchResult =
  | { ok: true; chats: KnownChat[] }
  | { ok: false; chats: [] };

interface Cached<T> { until: number; pending: boolean; value: Promise<T> }
interface ChatCache { list?: Cached<KnownChatsFetchResult>; details: Map<string, Cached<ChatInfoResult>> }
const caches = new WeakMap<LarkChannel, ChatCache>();
const LIST_TTL_MS = 15_000;
const DETAIL_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 5_000;
function cacheFor(channel: LarkChannel): ChatCache {
  let cache = caches.get(channel);
  if (!cache) { cache = { details: new Map() }; caches.set(channel, cache); }
  return cache;
}
export interface ChatInfoResult {
  code?: number; msg?: string; checkedAtMs: number;
  data?: { name?: string; chat_mode?: string; chat_status?: string };
}

/** One roster per channel/account, shared by all tools and concurrent readers. */
export async function fetchKnownChatsResult(channel: LarkChannel, force = false): Promise<KnownChatsFetchResult> {
  const cache = cacheFor(channel), old = cache.list;
  if (old && (old.pending || !force && Date.now() < old.until)) return structuredClone(await old.value);
  const entry: Cached<KnownChatsFetchResult> = { until: 0, pending: true, value: undefined! };
  const startedAt = Date.now();
  cache.list = entry;
  entry.value = (async (): Promise<KnownChatsFetchResult> => {
    try {
      const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
      entry.until = startedAt + LIST_TTL_MS;
      return { ok: true, chats: summaries.map(c => ({ id: c.id, name: c.name || '(无名)' })) };
    } catch (err) {
      entry.until = Date.now() + FAILURE_TTL_MS;
      log.warn('lark-info', 'chats-fetch-failed', { err: err instanceof Error ? err.message : String(err) });
      return { ok: false, chats: [] };
    } finally { entry.pending = false; }
  })();
  return structuredClone(await entry.value);
}

/** Detail evidence keeps its real read time; a missing roster entry is never evidence of dissolution. */
export async function fetchChatInfoResult(channel: LarkChannel, chatId: string, force = false): Promise<ChatInfoResult> {
  const cache = cacheFor(channel), old = cache.details.get(chatId);
  if (old && (old.pending || !force && Date.now() < old.until)) return structuredClone(await old.value);
  const entry: Cached<ChatInfoResult> = { until: 0, pending: true, value: undefined! };
  cache.details.set(chatId, entry);
  entry.value = (async () => {
    try {
      const result = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
      entry.until = Date.now() + (!result.code && result.data ? DETAIL_TTL_MS : FAILURE_TTL_MS);
      return { code: result.code, msg: result.msg, data: result.data, checkedAtMs: Date.now() };
    } catch (error) { entry.until = Date.now() + FAILURE_TTL_MS; throw error; }
    finally { entry.pending = false; }
  })();
  return structuredClone(await entry.value);
}

/** Drop in-flight entries too, so pre-write replies cannot overwrite post-write observations. */
export function invalidateChatInfo(channel: LarkChannel, chatId: string): void {
  const cache = caches.get(channel);
  if (cache) { cache.list = undefined; cache.details.delete(chatId); }
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  return (await fetchKnownChatsResult(channel)).chats;
}
