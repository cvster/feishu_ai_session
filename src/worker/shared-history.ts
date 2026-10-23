import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { WorkerJob } from './protocol';

/** Only a current, public shared group can mirror into its original personal group. */
export function sharedPersonalScope(controls: Controls, catalog: SessionCatalog | undefined, scope: string): string | undefined {
  if (!/^oc_[^:]+$/.test(scope) || controls.ownerRefreshState !== 'ok' || !controls.botOwnerId ||
      !controls.auxiliary?.isActive(scope) || catalog?.isScopeArchived(scope)) return;
  const group = controls.auxiliary.get(scope), binding = controls.toolBindings?.get(scope);
  if (!group || group.privateGroup || group.ownerId !== controls.botOwnerId || !binding?.sharedScope || !binding.linkedSource ||
      binding.toolId !== binding.linkedSource.toolId || binding.sourceId !== binding.linkedSource.sourceId ||
      binding.nativeId !== binding.linkedSource.nativeId || group.source?.nativeId !== binding.nativeId ||
      group.source.toolId !== binding.toolId || group.source.sourceId !== binding.sourceId) return;
  const owner = controls.toolBindings?.personalOwner(binding.linkedSource);
  if (!owner || catalog?.isScopeArchived(owner)) return;
  return owner;
}

export function sharedJobPersonalScope(controls: Controls, catalog: SessionCatalog | undefined, job: WorkerJob): string | undefined {
  const target = job.options.delivery;
  if (!target || target.chatId !== target.scope || target.botAppId !== controls.profileConfig.accounts.app.id) return;
  const binding = controls.toolBindings?.get(target.scope);
  if (!binding || target.sourceId !== binding.sourceId ||
      (job.options.threadId ?? job.options.sessionId ?? job.options.initialSessionId) !== binding.nativeId) return;
  return sharedPersonalScope(controls, catalog, target.scope);
}

/** Input comes from authenticated intake receipts, never the policy-bearing worker prompt. */
export function sharedJobMessages(controls: Controls, job: WorkerJob): NormalizedMessage[] {
  const target = job.options.delivery!, binding = controls.toolBindings?.get(target.scope);
  const inbox = binding && (controls.workerRuntimes?.get(binding.toolId)?.inbox ?? controls.workerInbox);
  const messages = new Map((inbox?.receipts(target.scope) ?? []).filter(r => r.status !== 'rejected' && r.message.chatId === target.chatId)
    .map(r => [r.message.messageId, r.message]));
  return (target.messageIds ?? []).flatMap(id => messages.has(id) ? [messages.get(id)!] : []);
}

const lookups = new WeakMap<LarkChannel, Map<string, { until: number; promise: Promise<string | undefined> }>>();
/** Receive events often omit names. Message reads supply Feishu names without contact permissions. */
export async function feishuSenderName(channel: LarkChannel, message: NormalizedMessage): Promise<string> {
  if (message.senderName?.trim()) return message.senderName;
  let cache = lookups.get(channel);
  if (!cache) { cache = new Map(); lookups.set(channel, cache); }
  const key = message.messageId, old = cache.get(key);
  if (old && old.until > Date.now()) return (await old.promise) ?? message.senderId;
  const entry = { until: Date.now() + 30_000, promise: (async () => {
    try {
      const response = await channel.rawClient.im.v1.message.get({ path: { message_id: message.messageId } });
      const item = response.data?.items?.find(item => item.message_id === message.messageId && item.sender?.id === message.senderId);
      const name = !response.code && item?.sender?.sender_name?.trim();
      if (name) return name;
    } catch { /* Group member reads are a fallback for older message API responses. */ }
    try {
      let token: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await channel.rawClient.im.v1.chatMembers.get({ path: { chat_id: message.chatId },
          params: { member_id_type: 'open_id', page_size: 100, ...(token ? { page_token: token } : {}) } });
        if (response.code || !response.data) break;
        const name = response.data.items?.find(item => item.member_id === message.senderId)?.name?.trim();
        if (name) return name;
        token = response.data.has_more ? response.data.page_token : undefined;
        if (token && seen.has(token)) break;
        if (token) seen.add(token);
      } while (token);
    } catch { /* A lookup outage must not prevent displaying the original message. */ }
    return undefined;
  })() };
  cache.set(key, entry);
  const name = await entry.promise;
  if (name) entry.until = Date.now() + 5 * 60_000;
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return name ?? message.senderId;
}

export async function namedSharedMessages(controls: Controls, channel: LarkChannel, job: WorkerJob) {
  const messages = sharedJobMessages(controls, job);
  const binding = controls.toolBindings?.get(job.options.delivery!.scope);
  const inbox = binding && (controls.workerRuntimes?.get(binding.toolId)?.inbox ?? controls.workerInbox);
  for (const message of messages) {
    message.senderName = await feishuSenderName(channel, message);
    if (message.senderName !== message.senderId) await inbox?.rememberSenderName(job.options.delivery!.scope, message.messageId, message.senderName);
  }
  return messages;
}
