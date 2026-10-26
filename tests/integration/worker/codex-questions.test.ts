import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCodexWorkerSessions } from '../../../src/worker/codex-sessions';
import { codexInputKey, type CodexInputAnswers } from '../../../src/session/codex-user-input';
const mocks = vi.hoisted(() => ({ snapshot: {} as any, reader: {} as any,
  rows: [] as Array<{ threadId: string; cwd: string; createdAtMs: number; updatedAtMs: number }> }));
vi.mock('../../../src/session/codex-thread-reader', () => ({ CodexThreadReader: class { constructor() { return mocks.reader; } } }));
vi.mock('../../../src/session/codex-history', async importOriginal => ({ ...await importOriginal<object>(), listCodexThreadHistory: async () => mocks.rows }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
beforeEach(() => {
  mocks.rows = [{ threadId: 'thread', cwd: '/project', createdAtMs: 1, updatedAtMs: 2 }];
  mocks.snapshot = { id: 'thread', status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'input' }] },
    { type: 'agentMessage', id: 'question', questions: [{ title: 'Choose', options: ['A', 'B'] }, { title: 'Other?' }] },
  ] }] };
  mocks.reader = { readThread: vi.fn(async () => mocks.snapshot), watchLoadedThread: vi.fn(async () => true), listArchivedThreadIds: vi.fn(async () => [] as string[]), steerTurn: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  mocks.reader.listArchivedThreads = vi.fn(async () => (await mocks.reader.listArchivedThreadIds()).map((id: string) => ({ id })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-worker-input-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'workers', 'codex'); await mkdir(stateDir, { recursive: true });
  const agent = { id: 'codex', displayName: 'Codex', run() { throw Error('Inference not permitted'); }, isAvailable: async () => true };
  const create = () => createCodexWorkerSessions({ binary: '/missing', profileStateDir: stateDir }, 'source', agent, 'app');
  const sessions = create(); cleanups.push(() => sessions.close!()); return { sessions, create, stateDir };
}
it('reads an existing new fork by exact ID when the native list omits it, without invoking inference', async () => {
  mocks.rows = [];
  mocks.reader.rpc = vi.fn(async () => ({ thread: { id: 'thread', cwd: '/project', name: 'AA-copy-2', createdAt: 1, updatedAt: 2 } }));
  const h = await fixture();
  expect(await h.sessions.conversation!('thread')).toMatchObject({ id: 'thread', name: 'AA-copy-2', cwd: '/project', archived: false });
  expect(mocks.reader.rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread', includeTurns: false });
  await h.sessions.conversation!('thread');
  expect(mocks.reader.rpc).toHaveBeenCalledOnce();
});
it('lists archived threads the worker never saw active, with their archive metadata', async () => {
  mocks.reader.listArchivedThreads = vi.fn(async () => [{ id: 'old', cwd: '/project', name: 'AA-old', createdAt: 1, updatedAt: 2 }, { id: 'thread', cwd: '/project' }]);
  const h = await fixture();
  const rows = await h.sessions.list!();
  expect(rows.find(row => row.nativeId === 'old')).toEqual({ nativeId: 'old', name: 'AA-old', cwd: '/project', createdAtMs: 1000, updatedAtMs: 2000, archived: true });
  expect(rows.find(row => row.nativeId === 'thread')).toMatchObject({ archived: true, createdAtMs: 1, updatedAtMs: 2 });
});
it('still reports archived status for a readable thread omitted from the active list', async () => {
  mocks.rows = [];
  mocks.reader.rpc = vi.fn(async () => ({ thread: { id: 'thread', cwd: '/project' } }));
  mocks.reader.listArchivedThreadIds.mockResolvedValue(['thread']);
  const h = await fixture();
  expect((await h.sessions.conversation!('thread')).archived).toBe(true);
});
it.each([undefined, { id: 'other', cwd: '/project' }, { id: 'thread', cwd: '' }])('rejects missing or mismatched exact native metadata (%j)', async thread => {
  mocks.rows = [];
  mocks.reader.rpc = vi.fn(async () => ({ thread }));
  const h = await fixture();
  await expect(h.sessions.conversation!('thread')).rejects.toThrow(/Native session/);
  expect(mocks.reader.readThread).not.toHaveBeenCalled();
});
it('exposes only current in-flight native questions and never invokes inference', async () => {
  const h = await fixture(), questions = await h.sessions.questions!('thread');
  expect(questions).toHaveLength(1); expect(questions[0]).toMatchObject({ available: true, origin: 'native', request: { kind: 'async', turnId: 'turn' } });
  mocks.snapshot.turns[0].status = 'completed'; expect(await h.sessions.questions!('thread')).toEqual([]);
});
it('supports partial asynchronous answers and keeps remaining questions answerable', async () => {
  const h = await fixture(), question = (await h.sessions.questions!('thread'))[0]!, [a, b] = question.request.questions;
  expect(await h.sessions.answer!('thread', question.id, { [a!.id]: { answers: ['A'] } })).toBe(true);
  const remaining = (await h.sessions.questions!('thread'))[0]!;
  expect(remaining.available).toBe(true); expect(remaining.request.answeredQuestionIds).toEqual([a!.id]);
  expect(await h.sessions.answer!('thread', question.id, { [b!.id]: { answers: ['custom'] } })).toBe(true);
  expect(await h.sessions.questions!('thread')).toEqual([]); expect(mocks.reader.steerTurn).toHaveBeenCalledTimes(2);
  expect(await readFile(join(h.stateDir, 'answer-claims.json'), 'utf8')).not.toContain('custom');
});
it('reserves before RPC and never retries an uncertain answer after restart', async () => {
  const h = await fixture(), question = (await h.sessions.questions!('thread'))[0]!, id = question.request.questions[0]!.id;
  mocks.reader.steerTurn.mockRejectedValueOnce(Error('receipt lost'));
  await expect(h.sessions.answer!('thread', question.id, { [id]: { answers: ['A'] } })).rejects.toThrow('receipt lost');
  const restarted = h.create();
  await expect(restarted.answer!('thread', question.id, { [id]: { answers: ['A'] } })).rejects.toThrow('Invalid question answers');
  expect(mocks.reader.steerTurn).toHaveBeenCalledOnce(); await restarted.close!();
});
it('serializes concurrent answers to the same question and rejects stale turns', async () => {
  const h = await fixture(), question = (await h.sessions.questions!('thread'))[0]!, id = question.request.questions[0]!.id;
  const results = await Promise.allSettled([h.sessions.answer!('thread', question.id, { [id]: { answers: ['A'] } }), h.sessions.answer!('thread', question.id, { [id]: { answers: ['A'] } })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(mocks.reader.steerTurn).toHaveBeenCalledOnce();
  mocks.snapshot.turns[0].id = 'another'; await expect(h.sessions.answer!('thread', question.id, { [id]: { answers: ['B'] } })).rejects.toThrow('stale');
});
it('responds to synchronous prompts through their original callback and rejects secret or unknown answers', async () => {
  const h = await fixture(), respond = vi.fn(async () => true);
  const request = { threadId: 'thread', turnId: 'turn', itemId: 'sync', isBlocking: true, questions: [{ id: 'sync-q', header: '', question: 'Choose', isOther: false, isSecret: false, options: [{ label: 'A', description: '' }] }] };
  h.sessions.receiveInput!({ requestId: 3, request, respond });
  const id = codexInputKey(request);
  const invalidAnswers: CodexInputAnswers[] = [{ 'sync-q': { answers: ['unlisted'] } }, { 'sync-q': { answers: ['A', 'B'] } }, { unknown: { answers: ['A'] } }, { 'sync-q': { answers: [''] } }];
  for (const answers of invalidAnswers)
    await expect(h.sessions.answer!('thread', id, answers)).rejects.toThrow('Invalid question answers');
  request.questions[0]!.isSecret = true;
  await expect(h.sessions.answer!('thread', id, { 'sync-q': { answers: ['private'] } })).rejects.toThrow('Invalid question answers');
  request.questions[0]!.isSecret = false;
  expect(respond).not.toHaveBeenCalled();
  expect(await h.sessions.answer!('thread', id, { 'sync-q': { answers: ['A'] } })).toBe(true);
  expect(respond).toHaveBeenCalledOnce(); expect(mocks.reader.steerTurn).not.toHaveBeenCalled();
  await expect(h.sessions.answer!('thread', id, { unknown: { answers: ['secret'] } })).rejects.toThrow();
});

it('automatically continues observed paused conversations without a worker job and stops after observation expires', async () => {
  vi.useFakeTimers();
  mocks.snapshot.status.type = 'idle'; mocks.snapshot.turns[0].status = 'interrupted';
  Object.assign(mocks.reader, {
    readThreadStatus: vi.fn(async () => mocks.snapshot.status), persistedTurnTerminal: vi.fn(async () => 'interrupted'),
    listQueuedSubmissions: vi.fn(async () => [{ id: 'existing' }]), addQueuedSubmission: vi.fn(async () => ({ id: 'queue' })),
    startQueuedTurn: vi.fn(async () => 'continued'), rpc: vi.fn(async () => ({ goal: null })),
  });
  const h = await fixture();
  await h.sessions.list(); await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.reader.startQueuedTurn).not.toHaveBeenCalled();
  await h.sessions.conversation!('thread'); await vi.advanceTimersByTimeAsync(15_000);
  await vi.waitFor(() => expect(mocks.reader.startQueuedTurn).toHaveBeenCalledOnce());
  // A different paused turn is ignored once the bridge stops observing it.
  await vi.advanceTimersByTimeAsync(60_000); mocks.snapshot.turns[0].id = 'later-pause';
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.reader.startQueuedTurn).toHaveBeenCalledOnce();
  await h.sessions.close!(); await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.reader.startQueuedTurn).toHaveBeenCalledOnce();
});
