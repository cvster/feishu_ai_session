import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { JobStore, jobIdFor, submissionFingerprint } from '../../../src/worker/store';
import type { WorkerJob, WorkerSubmission } from '../../../src/worker/protocol';
import { initialState } from '../../../src/card/run-state';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-queue-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const calls: AgentRunOptions[] = [],
    finish = new Map<string, () => void>();
  let stopped = 0;
  const agent: AgentAdapter = {
    id: 'claude',
    displayName: 'Claude',
    isAvailable: async () => true,
    run(options) {
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      finish.set(options.prompt, release);
      calls.push(options);
      return {
        runId: options.runId,
        stop: async () => {
          stopped++;
          release();
        },
        waitForExit: async () => true,
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'system' as const,
              sessionId: options.sessionId ?? options.initialSessionId ?? 'created-native',
              turnId: options.runId,
            };
            yield { type: 'text' as const, delta: 'started' };
            await barrier;
            yield { type: 'done' as const, terminationReason: 'normal' as const };
          },
        },
      };
    },
  };
  const input = (name: string, native = 'A'): WorkerSubmission => ({
    enqueue: true,
    requestKey: name,
    options: { runId: name, prompt: name, cwd: dir, sessionId: native },
  });
  return { dir, agent, calls, finish, input, stops: () => stopped };
}
it('serializes one native session, bypasses it for another session, and cancels only waiting jobs', async () => {
  const h = await setup();
  const server = await startWorkerServer({
    stateDir: h.dir,
    agent: h.agent,
    sourceId: 's',
    botAppId: 'a',
    maxConcurrent: 2,
  });
  cleanup.push(() => server.close());
  const c = new WorkerClient(h.dir, 's', 'a');
  expect((await c.health()).capabilities?.jobs.persistentQueue).toBe(true);
  const a = await c.submit(h.input('a'));
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  const second = await c.submit(h.input('a2'));
  const b = await c.submit(h.input('b', 'B'));
  await vi.waitFor(() => expect(h.calls.map((o) => o.prompt)).toEqual(['a', 'b']));
  expect((await c.snapshot(second.id)).job.queue?.dispatchedAt).toBeUndefined();
  await expect(c.cancelQueued(a.id)).rejects.toThrow('已开始');
  expect(h.stops()).toBe(0);
  await c.cancelQueued(second.id);
  expect((await c.snapshot(second.id)).job.status).toBe('interrupted');
  const next = await c.submit(h.input('a3'));
  await c.stop(a.id);
  await vi.waitFor(() => expect(h.calls.map((o) => o.prompt)).toEqual(['a', 'b', 'a3']));
  expect(h.stops()).toBe(1);
  expect((await c.submit(h.input('a3'))).id).toBe(next.id);
  h.finish.get('b')!();
  h.finish.get('a3')!();
  await vi.waitFor(async () => expect((await c.snapshot(b.id)).job.status).toBe('completed'));
});
it('persists waiting jobs across a graceful drain/restart and never dispatches while drained', async () => {
  const h = await setup();
  let server = await startWorkerServer({
    stateDir: h.dir,
    agent: h.agent,
    sourceId: 's',
    botAppId: 'a',
    maxConcurrent: 1,
  });
  cleanup.push(() => server.close());
  let c = new WorkerClient(h.dir, 's', 'a');
  await c.submit(h.input('first'));
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  const next = await c.submit(h.input('pending'));
  expect((await c.drain()).queued).toBe(1);
  await expect(c.submit(h.input('late'))).rejects.toThrow('停止接收');
  h.finish.get('first')!();
  await vi.waitFor(async () =>
    expect((await c.list()).find((j) => j.requestKey === 'first')?.status).toBe('completed'),
  );
  expect(h.calls).toHaveLength(1);
  await server.close();
  server = await startWorkerServer({
    stateDir: h.dir,
    agent: h.agent,
    sourceId: 's',
    botAppId: 'a',
    maxConcurrent: 1,
  });
  c = new WorkerClient(h.dir, 's', 'a');
  await vi.waitFor(() => expect(h.calls.map((o) => o.prompt)).toEqual(['first', 'pending']));
  expect((await c.submit(h.input('pending'))).id).toBe(next.id);
  h.finish.get('pending')!();
});
it('resumes the first confirmed native session for subsequent queued creation requests', async () => {
  const h = await setup();
  const server = await startWorkerServer({
    stateDir: h.dir,
    agent: h.agent,
    sourceId: 's',
    botAppId: 'a',
  });
  cleanup.push(() => server.close());
  const c = new WorkerClient(h.dir, 's', 'a');
  const input = (name: string): WorkerSubmission => ({
    ...h.input(name),
    options: {
      ...h.input(name).options,
      sessionId: undefined,
      initialSessionId: 'new-native',
      delivery: {
        scope: 'group',
        chatId: 'group',
        replyTo: '',
        operatorOpenId: 'owner',
        botAppId: 'a',
        sourceId: 's',
        policyFingerprint: 'p',
      },
    },
  });
  await c.submit(input('create'));
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await c.submit(input('continue'));
  h.finish.get('create')!();
  await vi.waitFor(() => expect(h.calls).toHaveLength(2));
  expect(h.calls[1]!.sessionId).toBe('new-native');
  expect(h.calls[1]!.initialSessionId).toBeUndefined();
  h.finish.get('continue')!();
});
it('quarantines dispatched work until its exact native turn is terminal, without replaying input', async () => {
  const h = await setup();
  const store = new JobStore(join(h.dir, 'jobs'));
  await store.load();
  const input = h.input('uncertain');
  const job: WorkerJob = {
    ...input,
    id: jobIdFor(input.requestKey),
    fingerprint: submissionFingerprint(input),
    version: 1,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    queue: { version: 1, sequence: 1, dispatchedAt: Date.now() },
  };
  await store.put(job);
  await store.append(job.id, { type: 'system', sessionId: 'A', turnId: 'exact-turn' });
  let done = false;
  const server = await startWorkerServer({
    stateDir: h.dir,
    agent: h.agent,
    sourceId: 's',
    botAppId: 'a',
    recoveryIntervalMs: 20,
    sessions: {
      list: async () => [],
      history: async () => undefined,
      conversation: async () => ({
        id: 'A',
        name: 'A',
        cwd: h.dir,
        archived: false,
        turns: [
          {
            id: 'exact-turn',
            input: 'uncertain',
            createdAtMs: job.createdAt,
            bridge: true,
            state: { ...initialState, terminal: done ? 'done' : 'running' },
          },
        ],
      }),
    },
  });
  cleanup.push(() => server.close());
  const c = new WorkerClient(h.dir, 's', 'a');
  const next = await c.submit(h.input('after-recovery'));
  expect((await c.snapshot(job.id)).job.queue?.recoveryPending).toBe(true);
  expect(h.calls).toHaveLength(0);
  done = true;
  await vi.waitFor(() => expect(h.calls.map((o) => o.prompt)).toEqual(['after-recovery']));
  expect((await c.snapshot(job.id)).job.status).toBe('completed');
  expect((await c.snapshot(next.id)).job.queue?.dispatchedAt).toBeTypeOf('number');
  h.finish.get('after-recovery')!();
});

it('detaches a supported native observer on shutdown instead of stopping its task',async()=>{
  const h=await setup();let detached=false,stops=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>release=resolve);
  h.agent.run=options=>({runId:options.runId,stop:async()=>{stops++;release();},detach:async()=>{detached=true;release();},waitForExit:async()=>true,
    events:{async *[Symbol.asyncIterator](){yield {type:'system' as const,sessionId:'A',turnId:'native-turn'};await barrier;}}});
  const server=await startWorkerServer({stateDir:h.dir,agent:h.agent,sourceId:'s',botAppId:'a'});
  const client=new WorkerClient(h.dir,'s','a');const job=await client.submit(h.input('keep-running'));
  await vi.waitFor(async()=>expect((await client.snapshot(job.id)).events.some(r=>r.event.type==='system'&&r.event.turnId==='native-turn')).toBe(true));
  await server.close();expect(detached).toBe(true);expect(stops).toBe(0);
  const stored=server.store.get(job.id)!;expect(stored.status).toBe('unknown');expect(stored.queue?.recoveryPending).toBe(true);
});
