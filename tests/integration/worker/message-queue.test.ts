import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { fixture } from '../../helpers/worker-fixture';
import { WorkerInbox } from '../../../src/worker/inbox';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ToolRegistry } from '../../../src/tools/types';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { createMessageQueue, queuePreview, startQueueCards } from '../../../src/bot/message-queue';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { Controls } from '../../../src/commands';
async function setup() {
  const h = await fixture();
  const inboxPath = join(h.dir, 'inbox.json'), inbox = new WorkerInbox(inboxPath); await inbox.load();
  const bindings = new ToolBindingStore(join(h.dir, 'bindings.json')); await bindings.load();
  bindings.set('oc_group', { toolId: 'claude', sourceId: h.client.sourceId, nativeId: 'native' });
  bindings.set('oc_other', { toolId: 'claude', sourceId: h.client.sourceId, nativeId: 'other-native' });
  const tools = new ToolRegistry(); tools.register({ id: 'claude', sourceId: h.client.sourceId, label: 'Claude', agent: h.adapter, listSessions: async () => [] });
  const controls = { profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } }),
    ownerRefreshState: 'ok', botOwnerId: 'owner', toolBindings: bindings, toolRegistry: tools, workerRuntimes: new Map([['claude', { inbox }]]) } as unknown as Controls;
  const pending = new PendingQueue(60_000, () => {}); pending.block('oc_group');
  const queue = createMessageQueue(controls, pending);
  const push = async (id: string, scope = 'oc_group') => {
    const message = { messageId: id, chatId: scope, senderId: 'sender', senderName: 'Nick', content: id + '😀'.repeat(100), createTime: Date.now() } as NormalizedMessage;
    await inbox.receive(scope, message); inbox.markQueued(scope, message); pending.push(scope, message); return message;
  };
  return { ...h, inbox, inboxPath, bindings, controls, pending, queue, push };
}
it('cancels exactly one waiting message durably, enforces sender/owner access and isolates groups', async () => {
  const h = await setup();
  try {
    await h.push('one'); await h.push('two'); await h.push('other', 'oc_other');
    const id = h.queue.list('oc_group')[0]!.id;
    await expect(h.queue.remove('oc_group', id, 'stranger')).rejects.toThrow('只能删除');
    expect(await h.queue.remove('oc_other', id, 'owner')).toBe(false);
    expect(await h.queue.remove('oc_group', id, 'sender')).toBe(true);
    expect(h.queue.list('oc_group').map(e => e.text.slice(0, 3))).toEqual(['two']);
    expect(h.pending.snapshot().find(e => e.scope === 'oc_group')!.messages.map(m => m.messageId)).toEqual(['two']);
    const restored = new WorkerInbox(h.inboxPath); await restored.load();
    expect(restored.receipts('oc_group')[0]!.status).toBe('cancelled');
    expect(restored.markQueued('oc_group', restored.receipts('oc_group')[0]!.message)).toBe(false);
    expect(restored.available().some(e => e.message.messageId === 'one')).toBe(false);
    expect(await h.queue.remove('oc_group', id, 'owner')).toBe(false);
  } finally { h.pending.cancelAll(); await h.bindings.flush(); }
});
it('never cancels a handed-off message or a worker-accepted message whose receipt is still pending', async () => {
  const h = await setup();
  try {
    const first = await h.push('handed-off'), id = h.queue.list('oc_group')[0]!.id;
    h.pending.cancel('oc_group'); // Simulate synchronous debounce handoff.
    expect(h.queue.list('oc_group')).toEqual([]); expect(await h.queue.remove('oc_group', id, 'owner')).toBe(false);
    h.inbox.releaseQueued('oc_group', [first]);
    await h.client.submit({ requestKey: 'already-submitted', options: { ...h.options, delivery: { ...h.options.delivery!, messageIds: [first.messageId] } } });
    expect(await h.queue.remove('oc_group', id, 'owner')).toBe(false);
    expect(h.inbox.receipts('oc_group')[0]!.status).toBe('accepted'); expect(h.stop).not.toHaveBeenCalled();
    await h.push('racing'); const next = h.queue.list('oc_group')[0]!.id;
    const list = h.adapter.client.list.bind(h.adapter.client);
    vi.spyOn(h.adapter.client, 'list').mockImplementation(async () => { h.pending.cancel('oc_group'); return list(); });
    expect(await h.queue.remove('oc_group', next, 'owner')).toBe(false);
    expect(h.inbox.receipts('oc_group').find(e => e.message.messageId === 'racing')!.status).toBe('pending');
  } finally { h.pending.cancelAll(); await h.bindings.flush(); }
});
it('updates one persistent queue card, clips previews and removes only its chosen row', async () => {
  const h = await setup(); await h.push('one'); await h.push('two');
  const create = vi.fn(async () => ({ code: 0, data: { message_id: 'queue-message' } }));
  const channel = { createCard: vi.fn(async () => ({ cardId: 'queue-card' })), updateCardById: vi.fn(async () => {}), rawClient: { im: { v1: { message: { create } } } } } as unknown as LarkChannel;
  const deps = { controls: h.controls, channel, queue: h.queue, path: join(h.dir, 'queue-cards.json') };
  const first = await startQueueCards(deps);
  try {
    await first.runNow(); expect(create).toHaveBeenCalledOnce();
    const card = vi.mocked(channel.updateCardById).mock.calls.at(-1)![1] as any;
    expect(card.body.elements).toHaveLength(2); expect(JSON.stringify(card)).toContain('…');
    const token = card.body.elements[0].columns[1].elements[0].behaviors[0].value.arg;
    await h.queue.remove('oc_group', token, 'owner'); await first.runNow();
    expect((vi.mocked(channel.updateCardById).mock.calls.at(-1)![1] as any).body.elements).toHaveLength(1);
    await first.stop(); const second = await startQueueCards(deps);
    try { await second.runNow(); expect(create).toHaveBeenCalledOnce();
      await h.queue.remove('oc_group', h.queue.list('oc_group')[0]!.id, 'owner'); await second.runNow();
      expect(JSON.stringify(vi.mocked(channel.updateCardById).mock.calls.at(-1)![1])).toContain('已处理或移除');
      expect(create).toHaveBeenCalledOnce();
    } finally { await second.stop(); }
    expect(Array.from(queuePreview('a\n😀'.repeat(100)))).toHaveLength(81); // 80 code points, with surrogate pairs and ellipsis.
  } finally { await first.stop(); h.pending.cancelAll(); await h.bindings.flush(); }
});
