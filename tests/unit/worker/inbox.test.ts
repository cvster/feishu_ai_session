import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
