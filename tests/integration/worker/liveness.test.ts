import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, RunLiveness } from '../../../src/agent/types';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { cleanups } from '../../helpers/worker-fixture';

const orphan: RunLiveness = { state: 'orphaned', evidence: 'native:queue-id', message: '确认原生输入已失效；未自动重发。' };
async function fixture(graceMs = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-liveness-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const checks: { resolve(proof: RunLiveness): void; reject(error: Error): void }[] = [];
  let wake = () => {}, ended = false, waiting = false;
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => { events.push(event); wake(); };
  const detach = vi.fn(async () => { ended = true; wake(); });
  const stop = vi.fn(async () => { ended = true; emit({ type: 'done', terminationReason: 'interrupted' }); });
  const run = vi.fn((options) => ({ runId: options.runId, detach, stop, waitForExit: async () => true,
    checkLiveness: () => new Promise<RunLiveness>((resolve, reject) => checks.push({ resolve, reject })),
    events: { async *[Symbol.asyncIterator]() {
      yield { type: 'system', sessionId: 'native' } as AgentEvent;
      while (true) {
        if (events.length) yield events.shift()!;
        else if (ended) return;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } } }));
  const agent: AgentAdapter = { id: 'generic', displayName: 'Generic', isAvailable: async () => true, run };
  const server = await startWorkerServer({ stateDir: dir, agent, sourceId: 'local', botAppId: 'cli_test', maxConcurrent: 1,
    livenessGraceMs: graceMs, livenessIntervalMs: 20,
    sessions: { list: async () => [], history: async () => undefined, waitingForInput: () => waiting } });
  cleanups.push(() => server.close());
  const client = new WorkerClient(dir, 'local', 'cli_test', 'generic');
  const submit = (key = 'one') => client.submit({ requestKey: key, options: { runId: key, prompt: 'input ' + key, cwd: dir, sessionId: 'native' } });
  const job = await submit();
  const proof = async (index: number, value: RunLiveness | Error = orphan) => {
    await vi.waitFor(() => expect(checks.length).toBeGreaterThan(index));
    if (value instanceof Error) checks[index]!.reject(value); else checks[index]!.resolve(value);
  };
  return { server, client, submit, job, checks, proof, detach, stop, run, emit,
    waiting(value: boolean) { waiting = value; },
    finish() { ended = true; emit({ type: 'done', terminationReason: 'normal' }); } };
}

it('keeps a quiet newly accepted task within its grace period', async () => {
  const h = await fixture(120_000);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(h.checks).toHaveLength(0); expect(h.detach).not.toHaveBeenCalled();
  expect((await h.client.snapshot(h.job.id)).job.status).toBe('running');
});

it('releases an orphaned observer after three confirmations without cancelling or replaying native input', async () => {
  const h = await fixture();
  await h.proof(0); await h.proof(1);
  expect(h.detach).not.toHaveBeenCalled();
  await h.proof(2);
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('unknown'));
  const snapshot = await h.client.snapshot(h.job.id);
  expect(snapshot.events.map(e => e.event.type)).toEqual(['system', 'error']);
  expect(snapshot.events.at(-1)?.event).toMatchObject({ submissionStatus: 'unknown', message: orphan.message });
  expect(h.detach).toHaveBeenCalledOnce(); expect(h.stop).not.toHaveBeenCalled();
  expect((await h.submit()).id).toBe(h.job.id); expect(h.run).toHaveBeenCalledOnce();
  expect((await h.submit('next')).id).not.toBe(h.job.id); // Both concurrency and native lease are released.
});

it('resets confirmations on network errors, unknown state and native work still queued or running', async () => {
  const h = await fixture();
  const sequence: (RunLiveness | Error)[] = [orphan, { state: 'unknown' }, orphan, new Error('read timed out'), orphan, { state: 'busy' }, orphan, orphan];
  for (const [index, value] of sequence.entries()) await h.proof(index, value);
  await vi.waitFor(() => expect(h.checks).toHaveLength(9));
  expect(h.detach).not.toHaveBeenCalled(); expect((await h.client.snapshot(h.job.id)).job.status).toBe('running');
  h.checks[8]!.resolve(orphan);
  await vi.waitFor(() => expect(h.detach).toHaveBeenCalledOnce());
});

it('does not clear tasks waiting for user input and restarts confirmation after the wait is resolved', async () => {
  const h = await fixture(); await h.proof(0);
  await vi.waitFor(() => expect(h.checks).toHaveLength(2));
  h.waiting(true); h.checks[1]!.resolve(orphan);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(h.checks).toHaveLength(2); expect(h.detach).not.toHaveBeenCalled();
  h.waiting(false); await h.proof(2); await h.proof(3);
  await vi.waitFor(() => expect(h.checks).toHaveLength(5)); expect(h.detach).not.toHaveBeenCalled();
  h.checks[4]!.resolve(orphan); await vi.waitFor(() => expect(h.detach).toHaveBeenCalledOnce());
});

it('discards a stale third proof when new output arrives or the task completes', async () => {
  const h = await fixture(); await h.proof(0); await h.proof(1);
  await vi.waitFor(() => expect(h.checks).toHaveLength(3));
  h.emit({ type: 'text', delta: 'still running' });
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).events).toHaveLength(2));
  h.checks[2]!.resolve(orphan);
  await h.proof(3); await h.proof(4);
  await vi.waitFor(() => expect(h.checks).toHaveLength(6)); expect(h.detach).not.toHaveBeenCalled();
  h.finish(); await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  h.checks[5]!.resolve(orphan); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.detach).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
  expect((await h.client.snapshot(h.job.id)).events.map(e => e.event.type)).toEqual(['system', 'text', 'done']);
});
