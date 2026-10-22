import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { startWorkerQuestions } from '../../../src/bot/worker-questions';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { Controls } from '../../../src/commands';
import type { WorkerClient } from '../../../src/worker/client';
import type { WorkerQuestion } from '../../../src/worker/protocol';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(origin: WorkerQuestion['origin'] = 'native') {
  const tmp = await createTmpProfile('worker-question-ui-'); cleanups.push(() => tmp.cleanup());
  const channel = createFakeChannel(), catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  const bindings = new ToolBindingStore(join(tmp.profile, 'bindings.json')); await bindings.load();
  bindings.set('oc_owner', { toolId: 'codex', sourceId: 'source', nativeId: 'native', nativeCreated: true });
  bindings.set('aux_shared', { toolId: 'codex', sourceId: 'source', nativeId: 'native', linkedSource: { toolId: 'codex', sourceId: 'source', nativeId: 'native' } });
  bindings.linkAuxiliary('oc_shared', 'aux_shared');
  const controls = { profileConfig: createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'app', secret: 's', tenant: 'feishu' } } }), toolBindings: bindings } as Controls;
  const question: WorkerQuestion = { id: 'question', available: true, origin, request: { threadId: 'native', turnId: 'turn', itemId: 'item', isBlocking: true,
    questions: [{ id: 'q', header: 'Choose', question: 'Choose one', isOther: true, isSecret: false, options: [{ label: 'A', description: '' }] }] },
    delivery: { scope: 'oc_shared', chatId: 'oc_shared', replyTo: 'original', operatorOpenId: 'owner', botAppId: 'app', sourceId: 'source', policyFingerprint: 'p' } };
  const client = { questions: vi.fn(async () => [question]), answer: vi.fn(async () => true) };
  const tool = { id: 'codex', label: 'Codex', sourceId: 'source', agent: new FakeAgentAdapter({ id: 'codex' }), listSessions: async () => [] };
  const deps = { channel: channel as any, controls, catalog, tool, client: client as unknown as WorkerClient, profileDir: tmp.profile, intervalMs: 60000 };
  let handle = await startWorkerQuestions(deps); cleanups.push(() => handle.stop()); await handle.runNow();
  const ledger = async () => JSON.parse(await readFile(join(tmp.profile, 'codex-user-input.json'), 'utf8'));
  const delivery = async () => (await ledger()).entries[0][1].deliveries[0];
  return { channel, controls, catalog, question, client, handle, ledger, delivery, tmp, async restart() { await handle.stop(); handle = await startWorkerQuestions(deps); await handle.runNow(); return handle; } };
}
it.each(['native', 'worker'] as const)('routes %s questions to their allowed destination only', async origin => {
  const h = await fixture(origin), destinations = h.channel.rawClient.requests.filter(r => r.method === 'im.v1.message.create').map(r => (r.params as any).data.receive_id);
  expect(destinations).toEqual([origin === 'native' ? 'oc_owner' : 'oc_shared']);
});
it('never publishes unknown-origin questions', async () => {
  const h = await fixture('unknown'); expect(h.channel.rawClient.requests.filter(r => r.method === 'im.v1.message.create')).toEqual([]);
});
it('revalidates token, message, binding, source, application and archive before sending answers', async () => {
  const h = await fixture('worker'), d = await h.delivery();
  await expect(h.handle.handleAction(d.scope, 'wrong-message', d.token, { q_0: '0' })).rejects.toThrow();
  h.question.delivery!.botAppId = 'another-app'; await expect(h.handle.handleAction(d.scope, d.messageId, d.token, { q_0: '0' })).rejects.toThrow();
  h.question.delivery!.botAppId = 'app'; h.question.delivery!.sourceId = 'other-source'; await expect(h.handle.handleAction(d.scope, d.messageId, d.token, { q_0: '0' })).rejects.toThrow();
  h.question.delivery!.sourceId = 'source'; h.catalog.archiveScope(d.scope, 'native'); await expect(h.handle.handleAction(d.scope, d.messageId, d.token, { q_0: '0' })).rejects.toThrow();
  expect(h.client.answer).not.toHaveBeenCalled(); await h.catalog.flush();
});
it('keeps stable cards and tokens, and never persists answers or retries a lost answer receipt', async () => {
  const h = await fixture(), d = await h.delivery(); h.client.answer.mockRejectedValueOnce(Error('receipt lost'));
  await expect(h.handle.handleAction(d.scope, d.messageId, d.token, { custom_0: 'private-answer' })).rejects.toThrow('receipt lost');
  expect(await readFile(join(h.tmp.profile, 'codex-user-input.json'), 'utf8')).not.toContain('private-answer');
  const restarted = await h.restart(); expect(await h.delivery()).toMatchObject({ cardId: d.cardId, messageId: d.messageId, token: d.token });
  await expect(restarted.handleAction(d.scope, d.messageId, d.token, { q_0: '0' })).rejects.toThrow(); expect(h.client.answer).toHaveBeenCalledOnce();
  expect(h.channel.rawClient.requests.filter(r => r.method === 'im.v1.message.create')).toHaveLength(1);
});
it('marks an interrupted submission unconfirmed and never collects a secret answer', async () => {
  const h = await fixture(), d = await h.delivery(); h.question.request.questions[0]!.isSecret = true;
  await expect(h.handle.handleAction(d.scope, d.messageId, d.token, { custom_0: 'secret' })).rejects.toThrow('敏感'); expect(h.client.answer).not.toHaveBeenCalled();
  await h.handle.stop(); const ledger = await h.ledger(); ledger.entries[0][1].status = 'submitting';
  await writeFile(join(h.tmp.profile, 'codex-user-input.json'), JSON.stringify(ledger));
  await h.restart(); expect((await h.ledger()).entries[0][1].status).toBe('unconfirmed');
});
