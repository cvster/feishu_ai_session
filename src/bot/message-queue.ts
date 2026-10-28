import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { PendingQueue } from './pending-queue';
import { isPersonalWorkgroup } from '../tools/bindings';
import { DurableAgentAdapter } from '../worker/adapter';
import { messageRequestId } from '../worker/identity';
import { deliveryUuid, type CardPart } from '../card/multipart';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

export interface QueuedMessage { id: string; text: string; senderName: string; createdAtMs: number; messageId?: string; requestIds?: string[] }
export interface MessageQueue {
  list(scope: string): QueuedMessage[];
  remove(scope: string, id: string, actor: string): Promise<boolean>;
  observeReply?(scope: string, id: string, createdAtMs: number, running: boolean): void;
  forReply?(scope: string, id: string): QueuedMessage[];
}
/** Only waiting input is cancellable. A flushed batch belongs to its executor. */
export function createMessageQueue(controls: Controls, pending: PendingQueue, catalog?: SessionCatalog): MessageQueue {
  const replies = new Map<string, { scope: string; createdAtMs: number; checkedAtMs: number; binding: string }>();
  const bindingKey = (scope: string) => { const b = controls.toolBindings?.get(scope); return JSON.stringify([b?.toolId, b?.sourceId, b?.nativeId]); };
  function entries(scope: string) {
    const binding = controls.toolBindings?.get(scope), tool = binding && controls.toolRegistry?.find(binding.toolId);
    if (!binding || !isPersonalWorkgroup(scope, binding) || controls.auxiliary?.isAuxiliary(scope) ||
      catalog?.isScopeArchived(scope) || !tool || tool.sourceId !== binding.sourceId) return [];
    const inbox = controls.workerRuntimes?.get(binding.toolId)?.inbox;
    const waiting = new Set(pending.snapshot().find(e => e.scope === scope)?.messages.map(messageRequestId));
    return (inbox?.pendingReceipts(scope) ?? []).filter(e =>
      (!e.queued || waiting.has(e.requestId))).map(e => ({ ...e, inbox: inbox!,
        id: deliveryUuid(JSON.stringify([controls.profileConfig.accounts.app.id, scope, binding.toolId, binding.sourceId, binding.nativeId, e.requestId])) }));
  }
  return {
    observeReply(scope, id, createdAtMs, running) {
      if (running) replies.set(id, { scope, createdAtMs, checkedAtMs: Date.now(), binding: bindingKey(scope) });
      else replies.delete(id);
    },
    forReply(scope, id) {
      const candidates = [...replies.entries()].filter(([, r]) => r.scope === scope && r.binding === bindingKey(scope) && Date.now() - r.checkedAtMs < 60_000)
        .sort((a, b) => b[1].createdAtMs - a[1].createdAtMs || b[0].localeCompare(a[0]));
      return candidates[0]?.[0] === id ? this.list(scope) : [];
    },
    list: scope => entries(scope).map(e => ({ id: e.id, messageId: e.message.messageId, text: e.message.content || '[附件消息]', senderName: e.message.senderName ?? '用户', createdAtMs: Number(e.message.createTime) })),
    async remove(scope, id, actor) {
      let entry = entries(scope).find(e => e.id === id);
      if (!entry) return false;
      if (actor !== entry.message.senderId && (controls.ownerRefreshState !== 'ok' || actor !== controls.botOwnerId))
        throw new Error('只能删除自己排队的消息，所有者可删除全部排队消息。');
      const binding = controls.toolBindings?.get(scope), tool = binding && controls.toolRegistry?.find(binding.toolId);
      if (tool?.agent instanceof DurableAgentAdapter) {
        const jobs = await tool.agent.client.list();
        if (jobs.some(job => job.options.delivery?.scope === scope && job.options.delivery.messageIds?.includes(entry!.requestId))) {
          await entry.inbox.reconcile(jobs); return false;
        }
      }
      // The debounce timer or recovery may have handed off input during the RPC.
      entry = entries(scope).find(e => e.id === id);
      if (!entry) return false;
      if (actor !== entry.message.senderId && (controls.ownerRefreshState !== 'ok' || actor !== controls.botOwnerId))
        throw new Error('消息所有者已变化，请刷新队列。');
      // Synchronous removal and durable status change happen before any await.
      // Queue recovery cannot re-enqueue a cancelled receipt during fsync.
      pending.remove(scope, entry.requestId);
      return entry.inbox.cancelPending(scope, entry.requestId);
    },
  };
}
interface QueueDelivery { cardId?: string; messageId?: string; sequence: number; parts?: CardPart[]; sendingSince?: number; empty?: boolean; signature?: string }
/** Retire existing standalone queue cards in place; never send a replacement. */
export async function retireQueueCards(deps: { controls: Controls; channel: LarkChannel; path: string }) {
  let raw: { version: number; deliveries: Record<string, QueueDelivery & { retired?: boolean }> };
  try { raw = JSON.parse(await readFile(deps.path, 'utf8')); if (raw.version !== 1 || !raw.deliveries) throw new Error('Invalid queue card ledger'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const save = () => writeFileAtomic(deps.path, JSON.stringify(raw) + '\n', { mode: 0o600 });
  for (const [key, delivery] of Object.entries(raw.deliveries)) {
    if (delivery.retired || JSON.parse(key)[0] !== deps.controls.profileConfig.accounts.app.id) continue;
    try {
      const parts = delivery.parts ?? (delivery.cardId && delivery.messageId ? [{ cardId: delivery.cardId, messageId: delivery.messageId, sequence: delivery.sequence }] : []);
      for (const part of parts) if (part.cardId && part.messageId) {
        part.sequence++; delivery.parts = parts; await save();
        await deps.channel.updateCardById(part.cardId, { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '排队消息已移到最新回复卡片末尾。' }] } }, part.sequence);
      }
      delivery.retired = true; await save();
    } catch (error) { log.warn('queue', 'legacy-card-retire-failed', { error: error instanceof Error ? error.message : String(error) }); }
  }
}
