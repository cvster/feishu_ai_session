import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { NativeSessionLocks } from '../../../src/tools/locks';

describe('RunExecutor policy runtime options', () => {
  it('holds the native lease until the CLI process exits after emitting its result', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const locks = new NativeSessionLocks();
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 2), activeRuns: new ActiveRuns(),
      now: () => 1000, nativeSessionLocks: locks, nativeSessionKey: id => id });
    const execution = await executor.submit({ scopeId: 'first', sessionId: 'native', policy: policy() });
    let exit!: () => void;
    vi.spyOn(execution.run, 'waitForExit').mockImplementation(() => new Promise(resolve => { exit = () => resolve(true); }));
    const events = execution.subscribe()[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: 'done' });
    await vi.waitFor(() => expect(exit).toBeTypeOf('function'));
    await expect(executor.submit({ scopeId: 'other', sessionId: 'native', policy: policy() })).rejects.toMatchObject({ code: 'run-already-active' });
    exit(); await events.next();
    const release = locks.acquire('native'); expect(release).toBeTypeOf('function'); release?.();
  });
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
