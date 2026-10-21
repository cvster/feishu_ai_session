import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions, AgentEvent } from '../../src/agent/types';
import { startWorkerServer } from '../../src/worker/server';
import { WorkerClient } from '../../src/worker/client';
import { DurableClaudeAdapter } from '../../src/worker/adapter';
import type { WorkerSessionService } from '../../src/worker/protocol';
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export async function fixture(toolId: 'claude' | 'zcode' | 'kilo' | 'dsh' = 'claude', sessions?: WorkerSessionService) {
  const dir = await mkdtemp(join(tmpdir(), 'durable-worker-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const calls: AgentRunOptions[] = [];
  const stop = vi.fn(async () => { finish(); });
  const raw: AgentAdapter = { id: toolId, displayName: toolId, isAvailable: async () => true,
    run(options) { calls.push(options); return { runId: options.runId, stop, waitForExit: async () => true,
      events: { async *[Symbol.asyncIterator]() {
        yield { type: 'system', sessionId: options.sessionId ?? options.initialSessionId ?? 'native', cwd: options.cwd } as AgentEvent;
        yield { type: 'text', delta: 'before restart\n' } as AgentEvent;
        await barrier;
        if (stop.mock.calls.length) yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
        else { yield { type: 'text', delta: 'after restart' } as AgentEvent; yield { type: 'done', terminationReason: 'normal' } as AgentEvent; }
      } } }; } };
  const stateDir = join(dir, 'worker');
  const server = await startWorkerServer({ stateDir, agent: raw, sourceId: `local-${toolId}`, botAppId: 'cli_test', maxConcurrent: 2, sessions });
  cleanups.push(() => server.close());
  const client = new WorkerClient(stateDir, `local-${toolId}`, 'cli_test', toolId);
  const adapter = new DurableClaudeAdapter(client, raw);
  const options: AgentRunOptions = { runId: 'bridge-random', requestKey: 'message-one', prompt: 'real request', cwd: dir, initialSessionId: 'native',
    delivery: { scope: 'oc_group', chatId: 'oc_group', replyTo: 'om_origin', operatorOpenId: 'ou_owner',
      botAppId: 'cli_test', sourceId: `local-${toolId}`, policyFingerprint: 'fp', messageIds: ['om_origin'] } };
  return { dir, raw, stop, calls, finish, server, stateDir, client, adapter, options };
}
