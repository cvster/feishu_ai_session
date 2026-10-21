import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { WorkerInbox } from '../../../src/worker/inbox';
import { messageRequestId } from '../../../src/worker/identity';
import type { WorkerJob } from '../../../src/worker/protocol';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const msg = (id: string) => ({ messageId: id, content: 'request', chatId: 'group', rawContentType: 'text' } as NormalizedMessage);
async function inboxFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-inbox-')); dirs.push(dir);
  const path = join(dir, 'inbox.json'), inbox = new WorkerInbox(path); await inbox.load(); return { path, inbox };
}
it('persists input before debounce and recovers it only until the worker has a durable receipt', async () => {
  const h = await inboxFixture(); expect(await h.inbox.receive('group', msg('one'))).toBe(true);
  h.inbox.markQueued('group', msg('one')); expect(h.inbox.available()).toEqual([]);
  const restored = new WorkerInbox(h.path); await restored.load(); expect(restored.available()).toHaveLength(1);
  expect(await restored.receive('group', msg('one'))).toBe(false);
  await restored.reconcile([{ status: 'unknown', options: { delivery: { scope: 'group', messageIds: ['one'] } } } as WorkerJob]);
  const restarted = new WorkerInbox(h.path); await restarted.load(); expect(restarted.available()).toEqual([]);
  expect(await restarted.receive('group', msg('one'))).toBe(false);
});
it('preserves explicit pending-message cancellation across restarts', async () => {
  const h = await inboxFixture(); await h.inbox.receive('group', msg('cancelled'));
  h.inbox.markQueued('group', msg('cancelled')); await h.inbox.reject('group', [msg('cancelled')]);
  const restored = new WorkerInbox(h.path); await restored.load(); expect(restored.available()).toEqual([]);
  expect(await restored.receive('group', msg('new-message'))).toBe(true);
});
it('does not confuse different card action nonces with redelivery of the same click', () => {
  const original = { ...msg('carrier'), rawContentType: 'card_action', raw: { bridgeCallbackId: 'one' } };
  const later = { ...original, raw: { bridgeCallbackId: 'two' } };
  expect(messageRequestId(original)).not.toBe(messageRequestId(later));
  expect(messageRequestId({ ...original })).toBe(messageRequestId(original));
});
it('fails closed on damaged receipts', async () => {
  const h = await inboxFixture(); await writeFile(h.path, '{"version":1,"entries":{"bad":{}}}');
  await expect(new WorkerInbox(h.path).load()).rejects.toThrow('Invalid');
});

it('rejects all inputs from an exiting group, including queued/deferred items, without cancelling peers', async () => {
  const h = await inboxFixture();
  await h.inbox.receive('group', msg('queued')); h.inbox.markQueued('group', msg('queued'));
  await h.inbox.receive('group', msg('deferred')); h.inbox.defer('group', [msg('deferred')]);
  await h.inbox.receive('other', msg('peer'));
  await h.inbox.rejectScope('group');
  const restored = new WorkerInbox(h.path); await restored.load();
  expect(restored.available().map(e => e.message.messageId)).toEqual(['peer']);
});

it('rejects dissolved group intake including unmaterialized topics while preserving accepted receipts and peer groups', async () => {
  const h = await inboxFixture();
  await h.inbox.receive('oc_dead', msg('root'));
  await h.inbox.receive('oc_dead:new-topic', msg('topic')); h.inbox.markQueued('oc_dead:new-topic', msg('topic'));
  await h.inbox.receive('oc_dead:accepted', msg('accepted'));
  await h.inbox.reconcile([{ options: { delivery: { scope: 'oc_dead:accepted', messageIds: ['accepted'] } } } as WorkerJob]);
  await h.inbox.receive('oc_dead_other:topic', msg('peer'));
  await h.inbox.rejectChat('oc_dead');
  const restored = new WorkerInbox(h.path); await restored.load();
  expect(restored.available().map(e => e.message.messageId)).toEqual(['peer']);
  const states = Object.values(JSON.parse(await readFile(h.path, 'utf8')).entries) as { message: NormalizedMessage; status: string }[];
  expect(states.find(e => e.message.messageId === 'accepted')?.status).toBe('accepted');
});
