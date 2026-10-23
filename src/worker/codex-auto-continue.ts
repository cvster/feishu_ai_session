import { readFile } from 'node:fs/promises';
import type { CodexThreadReader } from '../session/codex-thread-reader';
import { isInterruptedTurnStatus } from '../session/codex-turn-status';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

type Client = Pick<CodexThreadReader, 'readThreadStatus' | 'readThread' | 'listQueuedSubmissions' |
  'startQueuedTurn' | 'persistedTurnTerminal' | 'listArchivedThreadIds'>;
interface Attempt { at: number; turnId?: string; queueId?: string; confirmed?: boolean }

/** Provider-owned maintenance of conversations currently observed by the bridge.
 * Like the desktop Resume button, it starts only existing queued input.
 * Empty queues need no action. Never inject a continuation prompt or alter goals.
 * Persist per queue item before starting: uncertain receipts cannot replay it.
 */
export function startCodexAutoContinue(deps: {
  client: Client; targets(): string[]; statePath: string; intervalMs?: number;
}) {
  let attempts: Record<string, Attempt> = {};
  let loaded: Promise<void> | undefined;
  const load = () => loaded ??= readFile(deps.statePath, 'utf8').then(text => {
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.attempts || typeof value.attempts !== 'object' || Array.isArray(value.attempts))
      throw new Error('Invalid Codex auto-continue ledger');
    attempts = value.attempts;
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const save = () => writeFileAtomic(deps.statePath, JSON.stringify({ version: 1, attempts }), { mode: 0o600 });
  let stopped = false, running: Promise<void> | undefined;
  async function check() {
    await load();
    for (const id of deps.targets()) {
      if (stopped) return;
      let claimedKey: string | undefined;
      try {
        if ((await deps.client.readThreadStatus(id))?.type !== 'idle') continue;
        const snapshot = await deps.client.readThread(id), tail = snapshot.turns.at(-1);
        if (snapshot.id !== id || snapshot.status?.type !== 'idle') continue;
        if (!tail || !isInterruptedTurnStatus(tail.status) ||
          await deps.client.persistedTurnTerminal(snapshot, tail.id) !== 'interrupted') continue;
        if ((await deps.client.listArchivedThreadIds()).includes(id)) continue;
        const queued = await deps.client.listQueuedSubmissions(id);
        const next = queued[0];
        if (!next) continue;
        const key = JSON.stringify([id, 'queue', next.id]);
        if (attempts[key]) continue;
        const current = await deps.client.readThread(id);
        if (stopped || !deps.targets().includes(id) || current.id !== id || current.status?.type !== 'idle' ||
          current.turns.at(-1)?.id !== tail?.id || current.turns.at(-1)?.status !== tail?.status) continue;
        const attempt = attempts[key] = { at: Date.now(), queueId: next.id } as Attempt;
        await save();
        claimedKey = key;
        if (stopped) return;
        attempt.turnId = await deps.client.startQueuedTurn(id, next.id);
        attempt.confirmed = true; await save();
        log.info('codex-auto-continue', 'resumed', { threadId: id, queued: queued.length, turnId: attempt.turnId });
      } catch (error) {
        // A native RPC rejection proves the mutation was not accepted. Fresh
        // reads may retry it; already-accepted queue input remains in place.
        // Transport failures retain the claim because delivery is uncertain.
        if (claimedKey && error instanceof Error && error.name === 'CodexRpcError') {
          delete attempts[claimedKey]; await save();
        }
        log.warn('codex-auto-continue', 'resume-unavailable', { threadId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const runNow = () => stopped ? Promise.resolve() : running ??= check().catch(error => {
    log.warn('codex-auto-continue', 'check-unavailable', { error: String(error) });
  }).finally(() => { running = undefined; });
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? 15_000); timer.unref();
  return { runNow, async stop() { stopped = true; clearInterval(timer); await running; } };
}
