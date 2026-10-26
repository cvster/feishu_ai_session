import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexQueueRun } from '../../src/agent/codex/queue.js';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('CodexAdapter native queue mode', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each([undefined, 'unix://', 'unix:///tmp/name-sync.sock'])('renames through the live shared writer (%s) without submitting input', async remote => {
    vi.stubEnv('CODEX_QUEUE_REMOTE', undefined);
    const fake = await createQueueCodex(); cleanup.push(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, appServerRemote: remote });
    await adapter.setThreadName('thread-existing', 'AA-tarsc学习3');
    const requests = (await readFile(join(fake.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(r => r.method)).toEqual(['initialize', 'initialized', 'thread/name/set']);
    expect(requests.at(-1)).toMatchObject({ transport: 'shared', params: { threadId: 'thread-existing', name: 'AA-tarsc学习3' } });
    expect(requests.at(-1).argv).toEqual(['app-server', 'proxy', ...(remote?.startsWith('unix:///') ? ['--sock', remote.slice(7)] : [])]);
  });

  it.each([undefined, 'AA-Skill-仿真展示'])('names/materializes a fresh thread before queueing (%s), without starting a bridge-owned turn', async sessionName => {
    const fake = await createQueueCodex(); cleanup.push(fake.dir);
    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'fresh-queue', cwd: fake.dir, prompt: 'first Feishu message', model: 'gpt-6.1-sol', reasoningEffort: 'high',
      sessionName,
    });
    const events = await collect(run.events);
    expect(events[0]).toMatchObject({ type: 'system', threadId: 'thread-existing', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    const requests = (await readFile(join(fake.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(r => r.method)).toContain('thread/start');
    expect(requests.map(r => r.method)).not.toContain('turn/start');
    expect(requests.slice(0, 5).map(r => r.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/name/set', 'thread/read']);
    expect(requests.find(r => r.method === 'thread/name/set').params).toEqual({ threadId: 'thread-existing', name: sessionName ?? 'Codex会话' });
    const start = requests.find(r => r.method === 'thread/start');
    expect(start.params).not.toHaveProperty('developerInstructions');
    expect(start.params).toMatchObject({ historyMode: 'legacy', model: 'gpt-6.1-sol', config: { model_reasoning_effort: 'high' } });
    expect(await readFile(join(fake.dir, 'materialized.txt'), 'utf8')).toBe('ready');
    expect(run.detach).toBeTypeOf('function');
  });

  it.each(['existing', 'fresh'] as const)('detaches %s execution without interrupting or deleting the accepted submission', async (kind) => {
    const fake = await createQueueCodex('inProgress'); cleanup.push(fake.dir);
    const opts = { runId: 'detach', cwd: fake.dir, prompt: 'keep running',
      sessionName: 'AA-初始名称',
      ...(kind === 'existing' ? { threadId: 'thread-existing' } : {}) };
    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run(opts);
    const seen: AgentEvent[] = [];
    const drain = (async () => { for await (const event of run.events) seen.push(event); })();
    await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ type: 'system', turnId: 'turn-queued' })));
    await run.detach!(); await drain;
    const requests = await readFile(join(fake.dir, 'requests.jsonl'), 'utf8');
    expect(requests).not.toContain('turn/interrupt'); expect(requests).not.toContain('thread/queue/delete');
    if (kind === 'existing') expect(requests).not.toContain('thread/name/set');
    expect(seen.some(e => e.type === 'done' || e.type === 'error')).toBe(false);
    expect(JSON.parse(await readFile(join(fake.dir, 'state.json'), 'utf8')).prompt).toBe('keep running');
    expect(await run.waitForExit(0)).toBe(true);
  });

  it.each(['existing', 'fresh'] as const)('reconciles an inactive %s observer when the writer is idle and its queue is empty, including executed native history', async kind => {
    const fake = await createQueueCodex('missing-queue'); cleanup.push(fake.dir);
    const run = kind === 'fresh' ? new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: fake.dir, appServerRemote: 'unix://' })
      .run({ runId: 'orphan', cwd: fake.dir, prompt: 'lost input', sessionName: 'AA-test' }) : createCodexQueueRun({ runId: 'orphan', binary: fake.path, profileStateDir: fake.dir,
      codexHome: fake.dir, inheritCodexHome: false, remote: 'unix://', cwd: fake.dir,
      sandbox: 'workspace-write', prompt: 'lost input', threadId: 'thread-existing', clientUserMessageId: 'orphan-test' });
    const seen: AgentEvent[] = [], drain = (async () => { for await (const event of run.events) seen.push(event); })();
    try {
      await vi.waitFor(() => expect(seen.filter(event => event.type === 'system')).toHaveLength(kind === 'fresh' ? 2 : 1));
      const baselineProof = await run.checkLiveness!();
      expect(baselineProof).toMatchObject({ state: 'orphaned' });
      for (const mode of ['active', 'pending', 'unfinished', 'pending-after-history', 'active-after-history']) {
        await writeFile(join(fake.dir, 'liveness.json'), JSON.stringify({ mode }));
        expect((await run.checkLiveness!()).state).not.toBe('orphaned');
      }
      await writeFile(join(fake.dir, 'liveness.json'), JSON.stringify({ mode: 'unavailable' }));
      await expect(run.checkLiveness!()).rejects.toThrow('queue unavailable');
      await writeFile(join(fake.dir, 'liveness.json'), JSON.stringify({ mode: 'newturn' }));
      const executedProof = await run.checkLiveness!();
      expect(executedProof).toMatchObject({ state: 'orphaned' });
      expect(executedProof).not.toEqual(baselineProof); // New native activity resets consecutive confirmations.
      await writeFile(join(fake.dir, 'liveness.json'), JSON.stringify({ mode: 'idle' }));
      await appendFile(join(fake.dir, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'hidden-executed-turn' } }) + '\n');
      // Completed history does not imply success of this particular request,
      // but must not permanently block releasing an inactive observer either.
      await expect(run.checkLiveness!()).resolves.toMatchObject({ state: 'orphaned' });
    } finally { await run.detach!(); await drain; }
    const requests = (await readFile(join(fake.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(r => r.method === 'thread/queue/list').every(r => r.transport === 'shared')).toBe(true);
    for (const method of ['turn/start', 'thread/queue/add', 'thread/queue/delete', 'turn/interrupt']) expect(requests.some(r => r.method === method)).toBe(false);
    expect(seen.some(e => e.type === 'done' || e.type === 'error')).toBe(false);
  });

  it('explicit stop still interrupts through the shared writer, not the history reader', async () => {
    const fake = await createQueueCodex('inProgress'); cleanup.push(fake.dir);
    const run = createCodexQueueRun({ runId: 'stop', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write', prompt: 'stop me',
      threadId: 'thread-existing', clientUserMessageId: 'stop-test' });
    const seen: AgentEvent[] = []; const drain = (async () => { for await (const e of run.events) seen.push(e); })();
    await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ turnId: 'turn-queued' })));
    await run.stop(); await drain;
    expect(await readFile(join(fake.dir, 'interrupted.txt'), 'utf8')).toBe('proxy');
  });

  it('queues into an existing thread and returns the new turn without resuming the writer', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-run',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue from Feishu',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-run',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });

  it('updates the shared writer before queueing and reports actual model and effort', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-model-change', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'use the selected model', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-model-change',
      model: 'gpt-6-sol', reasoningEffort: 'high', remote: 'unix://',
    });
    const events = await collect(run.events);
    expect(events.filter((event) => event.type === 'system')).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', model: 'gpt-6-sol', reasoningEffort: 'high' },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(JSON.parse(await readFile(join(fake.dir, 'settings.json'), 'utf8'))).toEqual({
      threadId: 'thread-existing', model: 'gpt-6-sol', effort: 'high',
      cwd: fake.dir, approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [fake.dir], networkAccess: false },
    });
  });

  it('returns the durable answer when the shared writer index omits a completed execution', async () => {
    const fake = await createQueueCodex('stale-projection'); cleanup.push(fake.dir);
    const run = createCodexQueueRun({ runId: 'stale', binary: fake.path, profileStateDir: fake.dir, codexHome: fake.dir,
      inheritCodexHome: false, remote: 'unix://', cwd: fake.dir, sandbox: 'read-only', prompt: 'raw request',
      threadId: 'thread-existing', clientUserMessageId: 'bridge-stale' });
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'durable answer' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
    const requests = (await readFile(join(fake.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(r => r.method === 'thread/read').every(r => r.transport === 'shared')).toBe(true);
    expect(requests.some(r => ['turn/interrupt', 'thread/queue/delete', 'thread/resume'].includes(r.method))).toBe(false);
  });

  it.each(['newline', 'parts'] as const)('recognizes completed queued input with native %s formatting and releases its observer', async formatting => {
    const fake = await createQueueCodex('completed', false, formatting); cleanup.push(fake.dir);
    const prompt = formatting === 'parts' ? 'first line\nsecond line' : 'group request';
    const run = createCodexQueueRun({ runId: 'native-format', binary: fake.path, profileStateDir: fake.dir,
      codexHome: fake.dir, inheritCodexHome: false, remote: 'unix://', cwd: fake.dir,
      sandbox: 'read-only', prompt, threadId: 'thread-existing', clientUserMessageId: 'native-format' });
    try {
      const seen: AgentEvent[] = [];
      const drain = (async () => { for await (const event of run.events) seen.push(event); })();
      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' }));
      await drain;
      expect(seen).toContainEqual({ type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' });
      expect(seen).toContainEqual({ type: 'text', delta: 'queued response' });
      expect(await run.waitForExit(0)).toBe(true);
      const requests = await readFile(join(fake.dir, 'requests.jsonl'), 'utf8');
      expect(requests).not.toContain('turn/interrupt'); expect(requests).not.toContain('thread/queue/delete');
    } finally { await run.detach!(); }
  });

  it('does not queue when the writer rejects the selected model', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-invalid-model', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'must not run with the old model', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-invalid-model',
      model: 'unsupported-model', remote: 'unix://',
    });
    expect(await collect(run.events)).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('model unavailable') }),
    ]);
    await expect(readFile(join(fake.dir, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads a dormant thread only inside the shared daemon before updating settings', async () => {
    const fake = await createQueueCodex('completed', true);
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-dormant', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'continue dormant thread', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-dormant',
      model: 'gpt-6-sol', reasoningEffort: 'high', remote: 'unix://',
    });
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(await readFile(join(fake.dir, 'resumed.txt'), 'utf8')).toBe('proxy');
  });

  it('finishes an interrupted queued turn instead of polling forever', async () => {
    const fake = await createQueueCodex('interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'stop from Desktop',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-interrupted',
      pollIntervalMs: 5,
      interruptedSettleMs: 15,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'interrupted' },
    ]);
    await expect(run.waitForExit(0)).resolves.toBe(true);
  });

  it('keeps polling when an unfinished queued turn is provisionally interrupted', async () => {
    const fake = await createQueueCodex('provisional-interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-provisional-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue after transient status',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-provisional-interrupted',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });

  it('waits through a transient interrupted snapshot that already has a completion timestamp', async () => {
    const fake = await createQueueCodex('provisional-completed-interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-provisional-completed-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue after stale terminal projection',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-provisional-completed-interrupted',
      pollIntervalMs: 5,
      interruptedSettleMs: 15,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createQueueCodex(
  turnStatus: 'completed' | 'interrupted' | 'provisional-interrupted' |
    'provisional-completed-interrupted' | 'inProgress' | 'missing-queue' | 'stale-projection' = 'completed',
  startUnloaded = false,
  inputFormatting: 'original' | 'newline' | 'parts' = 'original',
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-queue-test-'));
  const statePath = join(dir, 'state.json');
  const scriptPath = join(dir, 'codex-fake.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { Duplex } from 'node:stream';
import WebSocket from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('ws')).href)};
const { WebSocketServer } = WebSocket;
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const rolloutPath = ${JSON.stringify(join(dir, 'rollout.jsonl'))};
const settingsPath = ${JSON.stringify(join(dir, 'settings.json'))};
const creatorLease = ${JSON.stringify(join(dir, 'creator-lease'))};
let ownsCreatorLease = false;
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => {
  if (ownsCreatorLease) {
    rmSync(creatorLease, { force: true });
    writeFileSync(${JSON.stringify(join(dir, 'creator-released.txt'))}, 'released');
  }
});
let queuedReads = 0;
let terminalWritten = false;
let lastLivenessMode, livenessQueueReads = 0, livenessStatusReads = 0;
if (args[0] === 'queue') {
  if (existsSync(creatorLease)) { console.error('thread thread-existing already has an active writer'); process.exit(9); }
  if (existsSync(${JSON.stringify(join(dir, 'started.txt'))}) && !existsSync(${JSON.stringify(join(dir, 'materialized.txt'))})) process.exit(7);
  const prompt = args[args.indexOf('--message') + 1];
  writeFileSync(statePath, JSON.stringify({ prompt }));
  writeFileSync(rolloutPath, ${JSON.stringify(turnStatus)} === 'missing-queue' ? '' : JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-queued' }
  }) + '\\n');
  if (existsSync(settingsPath) && ${JSON.stringify(turnStatus)} !== 'missing-queue') {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'turn_context', payload: { turn_id: 'turn-queued', model: settings.model, effort: settings.effort }
    }) + '\\n');
  }
  if (${JSON.stringify(turnStatus)} === 'stale-projection') {
    for (const item of [
      { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: prompt }] },
      { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'durable answer' }], phase: 'final_answer' }
    ]) appendFileSync(rolloutPath, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread-existing', turn_id: 'turn-queued', item } }) + '\\n');
    appendFileSync(rolloutPath, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-queued' } }) + '\\n');
  }
  console.log('Queued message queue-1 for thread thread-existing.');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(3);
let socket;
let loaded = ${JSON.stringify(!startUnloaded)};
const send = value => socket ? socket.send(JSON.stringify(value)) : console.log(JSON.stringify(value));
function handle(req) {
  const mode = existsSync(${JSON.stringify(join(dir, 'liveness.json'))}) ? JSON.parse(readFileSync(${JSON.stringify(join(dir, 'liveness.json'))}, 'utf8')).mode : 'idle';
  if (mode !== lastLivenessMode) { lastLivenessMode = mode; livenessQueueReads = 0; livenessStatusReads = 0; }
  appendFileSync(${JSON.stringify(join(dir, 'requests.jsonl'))}, JSON.stringify({ ...req, argv: args, transport: args[1] === 'proxy' ? 'shared' : 'owned' }) + '\\n');
  if (req.method === 'initialize') {
    send({ id: req.id, result: { userAgent: 'fake' } });
    return;
  }
  if (req.method === 'thread/start') {
    loaded = true;
    ownsCreatorLease = args[1] !== 'proxy';
    if (ownsCreatorLease) writeFileSync(creatorLease, String(process.pid));
    writeFileSync(${JSON.stringify(join(dir, 'started.txt'))}, 'idle');
    send({ id: req.id, result: { thread: { id: 'thread-existing' } } }); return;
  }
  if (req.method === 'thread/name/set') { send({ id: req.id, result: {} }); return; }
  if (req.method === 'turn/interrupt') {
    if (args[1] !== 'proxy') process.exit(8);
    writeFileSync(${JSON.stringify(join(dir, 'interrupted.txt'))}, args[1]);
    send({ id: req.id, result: {} }); return;
  }
  if (req.method === 'thread/settings/update') {
    if (args[1] !== 'proxy') process.exit(5);
    if (!loaded) {
      send({ id: req.id, error: { code: -32600, message: 'thread not found: thread-existing' } });
      return;
    }
    if (req.params.model === 'unsupported-model') {
      send({ id: req.id, error: { code: -32600, message: 'model unavailable' } });
      return;
    }
    writeFileSync(settingsPath, JSON.stringify(req.params));
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'thread/resume') {
    if (args[1] !== 'proxy') process.exit(6);
    if (existsSync(creatorLease)) {
      send({ id: req.id, error: { code: -32600, message: 'thread thread-existing already has an active writer' } }); return;
    }
    loaded = true;
    writeFileSync(${JSON.stringify(join(dir, 'resumed.txt'))}, args[1]);
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'thread/queue/list') {
    if (mode === 'unavailable') { send({ id: req.id, error: { code: -32600, message: 'queue unavailable' } }); return; }
    livenessQueueReads++;
    send({ id: req.id, result: { data: mode === 'pending' || mode === 'pending-after-history' && livenessQueueReads >= 2 ? [{ id: 'queue-1', input: [] }] : [] } }); return;
  }
  if (req.method === 'thread/queue/add') {
    if (existsSync(creatorLease)) {
      send({ id: req.id, error: { code: -32600, message: 'thread thread-existing already has an active writer' } }); return;
    }
    writeFileSync(statePath, JSON.stringify({ prompt: req.params.input[0].text }));
    send({ id: req.id, result: { queuedSubmission: { id: 'queue-rpc', input: req.params.input,
      clientUserMessageId: req.params.clientUserMessageId } } }); return;
  }
  if (req.method !== 'thread/read') return;
  if (!req.params.includeTurns) livenessStatusReads++;
  if (existsSync(${JSON.stringify(join(dir, 'started.txt'))}) && req.params.includeTurns) writeFileSync(${JSON.stringify(join(dir, 'materialized.txt'))}, 'ready');
  const queued = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
  if (queued) queuedReads += 1;
  const configuredStatus = ${JSON.stringify(turnStatus)};
  const transientInterrupted = configuredStatus === 'provisional-interrupted';
  const status = configuredStatus === 'provisional-completed-interrupted'
    ? 'interrupted'
    : transientInterrupted && queuedReads === 1
      ? 'interrupted'
      : transientInterrupted
      ? 'completed'
      : configuredStatus;
  if (queued && !terminalWritten && (
    status === 'completed' || configuredStatus === 'provisional-completed-interrupted'
  )) {
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-queued' }
    }) + '\\n');
    terminalWritten = true;
  } else if (queued && !terminalWritten && status === 'interrupted' && !transientInterrupted) {
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-queued' }
    }) + '\\n');
    terminalWritten = true;
  }
  const includeAgentMessage = configuredStatus !== 'provisional-completed-interrupted' ||
    queuedReads > 1;
  const turns = configuredStatus === 'missing-queue' || configuredStatus === 'stale-projection' ? (['newturn', 'unfinished'].includes(mode) ? [{ id: 'turn-other', status: mode === 'unfinished' ? 'inProgress' : 'completed', items: [] }] : []) : queued ? [{
    id: 'turn-queued',
    status,
    completedAt: status === 'interrupted' && configuredStatus === 'provisional-interrupted'
        ? null
        : Date.now() / 1000,
    error: null,
    items: [
      { type: 'userMessage', id: 'user-1', content: ${JSON.stringify(inputFormatting)} === 'parts'
        ? queued.prompt.split('\\n').map(text => ({ type: 'text', text }))
        : [{ type: 'text', text: queued.prompt + (${JSON.stringify(inputFormatting)} === 'newline' ? '\\n' : '') }] },
      ...(includeAgentMessage
        ? [{ type: 'agentMessage', id: 'agent-1', text: 'queued response', phase: 'final_answer' }]
        : [])
    ]
  }] : [];
  send({
    id: req.id,
    result: { thread: {
      id: 'thread-existing', path: rolloutPath, updatedAt: Date.now() / 1000, turns,
      ...(configuredStatus === 'missing-queue' ? { status: { type: mode === 'active' || mode === 'active-after-history' && livenessStatusReads >= 2 ? 'active' : 'idle' } } : {})
    } }
  });
}
if (args[1] === 'proxy') {
  const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
  const server = new WebSocketServer({ noServer: true });
  let handshake = Buffer.alloc(0);
  const upgrade = chunk => {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    stream.removeListener('data', upgrade);
    const lines = handshake.subarray(0, end).toString().split('\\r\\n');
    const headers = Object.fromEntries(lines.slice(1).map(line => {
      const index = line.indexOf(':');
      return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
    }));
    server.handleUpgrade({ method: 'GET', url: '/', headers }, stream, handshake.subarray(end + 4), ws => {
      socket = ws;
      socket.on('message', data => handle(JSON.parse(data.toString())));
    });
  };
  stream.on('data', upgrade);
} else {
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => handle(JSON.parse(line)));
}
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path };
}
