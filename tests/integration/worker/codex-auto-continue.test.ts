import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startCodexAutoContinue } from '../../../src/worker/codex-auto-continue';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(intervalMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-auto-continue-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const snapshot = { id: 'thread', status: { type: 'idle' }, turns: [{ id: 'paused', status: 'interrupted', items: [] }] };
  let targets = ['thread'];
  let goal: any = null;
  const client = {
    readThreadStatus: vi.fn(async () => snapshot.status),
    readThread: vi.fn(async () => structuredClone(snapshot)),
    persistedTurnTerminal: vi.fn(async () => 'interrupted' as const),
    listArchivedThreadIds: vi.fn(async () => [] as string[]),
    listQueuedSubmissions: vi.fn(async () => [{ id: 'existing', input: [] }] as any[]),
    addQueuedSubmission: vi.fn(async (..._args: any[]) => ({ id: 'new-queue', input: [] })),
    startQueuedTurn: vi.fn(async (..._args: any[]) => 'continued-turn'),
    rpc: vi.fn(async (method: string, _params: unknown) => method === 'thread/goal/set' ? { goal: { ...goal, status: 'active' } } : { goal }),
  };
  const start = () => { const handle = startCodexAutoContinue({ client, targets: () => targets, statePath, intervalMs }); cleanup.push(() => handle.stop()); return handle; };
  const handle = start();
  return { handle, client, snapshot, statePath, start, goal(value: any) { goal = value; }, targets(value: string[]) { targets = value; } };
}

it('periodically starts the existing queue once, with a stable receipt across polling and restart', async () => {
  const h = await fixture(20);
  await vi.waitFor(() => expect(h.client.startQueuedTurn).toHaveBeenCalledOnce());
  await h.handle.runNow(); await h.handle.stop();
  const restarted = h.start(); await restarted.runNow();
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
  expect(h.client.rpc).not.toHaveBeenCalled();
  expect(h.client.startQueuedTurn).toHaveBeenCalledWith('thread', 'existing');
  expect(JSON.parse(await readFile(h.statePath, 'utf8')).attempts).toEqual({
    '["thread","queue","existing"]': expect.objectContaining({ confirmed: true, turnId: 'continued-turn' }),
  });
  // New queue input after the same pause is eligible even without a new turn.
  h.client.listQueuedSubmissions.mockResolvedValue([{ id: 'later-input', input: [] }]);
  await restarted.runNow();
  expect(h.client.startQueuedTurn).toHaveBeenCalledTimes(2);
  expect(h.client.startQueuedTurn).toHaveBeenLastCalledWith('thread', 'later-input');
});

it('never synthesizes input for an empty queue, and resumes real input arriving later under the same pause', async () => {
  const h = await fixture(); h.client.listQueuedSubmissions.mockResolvedValue([]);
  h.goal({ status: 'paused', createdAt: 1, updatedAt: 2 });
  await h.handle.runNow(); await h.handle.runNow();
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
  expect(h.client.startQueuedTurn).not.toHaveBeenCalled();
  expect(h.client.rpc).not.toHaveBeenCalled();
  h.client.listQueuedSubmissions.mockResolvedValue([{ id: 'arrived-later', input: [] }]);
  await h.handle.runNow();
  expect(h.client.startQueuedTurn).toHaveBeenCalledWith('thread', 'arrived-later');
});

it('starts the existing queue head without adding or replacing any input', async () => {
  const h = await fixture(); h.client.listQueuedSubmissions.mockResolvedValue([{ id: 'existing', input: [] }, { id: 'later', input: [] }]);
  await h.handle.runNow(); await h.handle.runNow();
  expect(h.client.startQueuedTurn).toHaveBeenCalledOnce();
  expect(h.client.startQueuedTurn).toHaveBeenCalledWith('thread', 'existing');
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
});

it('does not reactivate a paused goal on a normally completed conversation', async () => {
  const h = await fixture(); h.snapshot.turns[0]!.status = 'completed'; h.goal({ status: 'paused', createdAt: 1, updatedAt: 2 });
  await h.handle.runNow();
  expect(h.client.rpc).not.toHaveBeenCalled();
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled(); expect(h.client.startQueuedTurn).not.toHaveBeenCalled();
});

it.each(['active', 'completed', 'archived', 'unconfirmed-interruption', 'new-turn', 'unobserved', 'read-error'] as const)(
  'does not resume a %s conversation', async kind => {
    const h = await fixture();
    if (kind === 'active') h.snapshot.status.type = 'active';
    if (kind === 'completed') h.snapshot.turns[0]!.status = 'completed';
    if (kind === 'archived') h.client.listArchivedThreadIds.mockResolvedValue(['thread']);
    if (kind === 'unconfirmed-interruption') h.client.persistedTurnTerminal.mockResolvedValue(undefined as any);
    if (kind === 'new-turn') h.client.readThread.mockImplementationOnce(async () => structuredClone(h.snapshot)).mockImplementationOnce(async () => ({ ...h.snapshot, turns: [{ id: 'new', status: 'completed', items: [] }] }));
    if (kind === 'unobserved') h.targets([]);
    if (kind === 'read-error') h.client.readThreadStatus.mockRejectedValue(Error('unavailable'));
    await h.handle.runNow();
    expect(h.client.addQueuedSubmission).not.toHaveBeenCalled(); expect(h.client.startQueuedTurn).not.toHaveBeenCalled();
    expect(h.client.rpc.mock.calls.some(([method]) => method === 'thread/goal/set')).toBe(false);
  });

it('preserves uncertain start receipts across restart instead of duplicating the continuation input', async () => {
  const h = await fixture(); h.client.startQueuedTurn.mockRejectedValueOnce(Error('lost receipt'));
  await h.handle.runNow(); await h.handle.runNow(); await h.handle.stop();
  const restarted = h.start(); await restarted.runNow();
  expect(h.client.startQueuedTurn).toHaveBeenCalledOnce(); expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
  expect(Object.values(JSON.parse(await readFile(h.statePath, 'utf8')).attempts)[0]).toMatchObject({ queueId: 'existing' });
});

it('retries an explicit native rejection with the same existing queue input', async () => {
  const h = await fixture();
  h.client.startQueuedTurn.mockRejectedValueOnce(Object.assign(Error('temporarily unavailable'), { name: 'CodexRpcError' }));
  await h.handle.runNow(); await h.handle.runNow();
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
  expect(h.client.startQueuedTurn).toHaveBeenCalledTimes(2);
  expect(h.client.startQueuedTurn).toHaveBeenLastCalledWith('thread', 'existing');
});

it('serializes overlapping polls without starting a queue item twice', async () => {
  const h = await fixture();
  await Promise.all([h.handle.runNow(), h.handle.runNow(), h.handle.runNow()]);
  expect(h.client.startQueuedTurn).toHaveBeenCalledOnce();
  expect(h.client.addQueuedSubmission).not.toHaveBeenCalled();
});
