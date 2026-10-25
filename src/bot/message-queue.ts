import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { PendingQueue } from './pending-queue';
import { isPersonalWorkgroup } from '../tools/bindings';
import { DurableAgentAdapter } from '../worker/adapter';
import { messageRequestId } from '../worker/identity';
import { deliveryUuid, publishCards, type CardPart } from '../card/multipart';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

export interface QueuedMessage { id: string; text: string; senderName: string; createdAtMs: number }
export interface MessageQueue {
  list(scope: string): QueuedMessage[];
  remove(scope: string, id: string, actor: string): Promise<boolean>;
}
export function queuePreview(text: string, limit = 80): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
}
/** Only waiting input is cancellable. A flushed batch belongs to its executor. */
export function createMessageQueue(controls: Controls, pending: PendingQueue, catalog?: SessionCatalog): MessageQueue {
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
    list: scope => entries(scope).map(e => ({ id: e.id, text: e.message.content || '[附件消息]', senderName: e.message.senderName ?? '用户', createdAtMs: Number(e.message.createTime) })),
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
export async function startQueueCards(deps: { controls: Controls; channel: LarkChannel; queue: MessageQueue; path: string }) {
  let deliveries: Record<string, QueueDelivery> = {};
  try { const raw = JSON.parse(await readFile(deps.path, 'utf8')); if (raw.version !== 1 || !raw.deliveries) throw new Error('Invalid queue card ledger'); deliveries = raw.deliveries; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => writeFileAtomic(deps.path, JSON.stringify({ version: 1, deliveries }) + '\n', { mode: 0o600 });
  let running: Promise<void> | undefined, stopped = false;
  async function sync() {
    for (const [scope, binding] of deps.controls.toolBindings?.entries() ?? []) {
      if (stopped || !isPersonalWorkgroup(scope, binding)) continue;
      const items = deps.queue.list(scope);
      const key = JSON.stringify([deps.controls.profileConfig.accounts.app.id, scope, binding.toolId, binding.sourceId]);
      if (!items.length && (!deliveries[key] || deliveries[key]!.empty)) continue;
      const delivery = deliveries[key] ??= { sequence: 0 };
      const escape = (text: string) => text.replace(/([\\*_`\[\]<>~])/g, '\\$1');
      const card = { schema: '2.0', config: { streaming_mode: false }, header: { title: { tag: 'plain_text', content: `排队消息（${items.length}）` } },
        body: { elements: items.length ? items.map(item => ({ tag: 'column_set', flex_mode: 'none', columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [{ tag: 'markdown', content: escape(queuePreview(item.text)) }] },
          { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '删除' }, type: 'danger',
            behaviors: [{ type: 'callback', value: { cmd: 'queue.remove', arg: item.id } }] }] },
        ] })) : [{ tag: 'markdown', content: '排队消息已处理或移除。' }] } };
      const signature = deliveryUuid(JSON.stringify(card));
      if (delivery.signature === signature) continue;
      try {
        await publishCards({ channel: deps.channel, target: { chatId: scope }, card, delivery, key: `queue:${key}`, save,
          active: () => { const current = deps.controls.toolBindings?.get(scope); return !stopped && current?.toolId === binding.toolId && current.sourceId === binding.sourceId && current.nativeId === binding.nativeId; } });
        delivery.empty = !items.length; delivery.signature = signature; await save();
      } catch (error) { log.warn('queue', 'card-update-failed', { scope, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  const runNow = () => running ??= sync().finally(() => { running = undefined; });
  const timer = setInterval(() => { if (!stopped) void runNow().catch(error => log.warn('queue', 'sync-failed', { error: String(error) })); }, 1000); timer.unref();
  return { runNow, async stop() { stopped = true; clearInterval(timer); await running; } };
}
