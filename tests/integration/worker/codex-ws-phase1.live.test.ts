import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createWorkerProvider } from '../../../src/worker/providers';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { CodexThreadReader } from '../../../packages/codex-core/src/thread-client';

// Opt-in integration with the installed, real Codex binary. Model responses are
// deterministic localhost SSE fixtures, not a substitute for desktop/model QA.
const enabled = process.env.BRIDGE_CODEX_WS_PHASE1 === '1';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => T | Promise<T>, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value as NonNullable<T>; } catch (error) { last = error; }
    await delay(75);
  }
  throw last ?? new Error(`Condition timed out after ${timeout}ms`);
}

class Rpc {
  messages: any[] = [];
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  next = 1;
  constructor(readonly socket: WebSocket) {
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); this.messages.push(message);
      if (message.id !== undefined && !message.method) {
        const task = this.pending.get(message.id); if (!task) return;
        this.pending.delete(message.id); clearTimeout(task.timer);
        if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
      }
    });
    socket.on('error', () => {});
  }
  static async connect(url: string, token?: string) {
    const socket = new WebSocket(url, { handshakeTimeout: 5000, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
    const rpc = new Rpc(socket);
    try { await once(socket, 'open'); } catch (error) { socket.terminate(); throw error; }
    await rpc.call('initialize', { clientInfo: { name: 'codex_feishu_phase1_test', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.socket.send(JSON.stringify({ method: 'initialized' })); return rpc;
  }
  call(method: string, params: any = {}, timeout = 20_000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  respond(id: number | string, result: unknown) { this.socket.send(JSON.stringify({ id, result })); }
  completed(id: string) {
    return until(() => this.messages.find(m => m.method === 'turn/completed' && m.params?.turn?.id === id), 30_000);
  }
  async close() {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('Test client closed')); }
    this.pending.clear(); this.socket.close();
    await Promise.race([once(this.socket, 'close'), delay(500)]); this.socket.terminate();
  }
}

type Plan = { kind: 'text'; text: string } | { kind: 'hold' } | { kind: 'question' };
async function modelFixture() {
  const plans: Plan[] = [], held = new Set<ServerResponse>(); let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [] })); return; }
    for await (const _chunk of req) { /* Drain only; no prompt/auth data is logged. */ }
    requests++; const plan = plans.shift() ?? { kind: 'text', text: 'PHASE1_DEFAULT' };
    const id = `response-${requests}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const event = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
    if (plan.kind === 'hold') { held.add(res); res.on('close', () => held.delete(res)); return; }
    const item = plan.kind === 'question' ? { type: 'function_call', id: `fc-${requests}`, call_id: `question-${requests}`,
      name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'confirm_path', header: 'Phase1', question: 'Continue the isolated test?',
        options: [{ label: 'Yes', description: 'Continue test' }, { label: 'No', description: 'Stop test' }] }] }) }
      : { type: 'message', id: `msg-${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: plan.text, annotations: [] }] };
    event({ type: 'response.output_item.added', output_index: 0, item });
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { url: `http://127.0.0.1:${address.port}/v1`, plans, held, get requests() { return requests; },
    async close() { for (const res of held) res.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([closed, delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

it.skipIf(!enabled)('phase 1: real local app-server and worker, isolated home and mock model', async () => {
  const binary = process.env.BRIDGE_CODEX_WS_PHASE1_BIN;
  if (!binary) throw new Error('Set BRIDGE_CODEX_WS_PHASE1_BIN to the installed Codex executable');
  const root = await mkdtemp(join(tmpdir(), 'codex-ws-phase1-'));
  const home = join(root, 'codex-home'), workspace = join(root, 'workspace'), profileDir = join(root, 'profile');
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(profileDir)]);
  const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = [];
  const reportPath = process.env.BRIDGE_CODEX_WS_PHASE1_REPORT ?? join(root, 'report.json');
  const children: ChildProcess[] = [], clients: Rpc[] = [], logs: ReturnType<typeof createWriteStream>[] = [];
  const fixture = await modelFixture(); let worker: Awaited<ReturnType<typeof startWorkerServer>> | undefined;
  let provider: Awaited<ReturnType<typeof createWorkerProvider>> | undefined;
  const check = async <T>(name: string, action: () => Promise<T>) => {
    try { const value = await action(); checks.push({ name, status: 'passed' }); return value; }
    catch (error) { checks.push({ name, status: 'failed', detail: String(error).slice(0, 1800) }); console.warn(`phase1 ${name}: ${String(error)}`); return undefined; }
  };
  const toml = `model = "gpt-6.1-sol"\nmodel_provider = "phase1"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.phase1]\nname = "Local deterministic phase1 fixture"\nbase_url = ${JSON.stringify(fixture.url)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[analytics]\nenabled = false\n`;
  await writeFile(join(home, 'config.toml'), toml);
  const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, 'sqlite') };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_QUEUE_REMOTE', 'CODEX_AUTH_TOKEN']) delete env[key as keyof typeof env];
  const port = await unusedPort(), url = `ws://127.0.0.1:${port}`;
  let launchUrl = url;
  const launch = (args: string[], label: string) => {
    const log = createWriteStream(join(root, `${label}.log`)); logs.push(log);
    const child = spawn(binary, ['app-server', '--listen', launchUrl, ...args], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false }); children.push(child); return child;
  };
  try {
    launch([], 'app-server');
    await check('loopback-health', async () => { await until(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200); });
    const rpc = await check('initialize-public-websocket', async () => { const r = await Rpc.connect(url); clients.push(r); return r; });
    if (rpc) {
      await check('isolated-account-not-authenticated', async () => { const account = await rpc.call('account/read', { refreshToken: false }); expect(account.account).toBeNull(); });
      const thread = await check('create-isolated-thread', async () => {
        const result = await rpc.call('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'phase1', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' });
        expect(result.thread.id).toBeTruthy(); return result.thread.id as string;
      });
      if (thread) {
        await check('native-message-reply', async () => {
          fixture.plans.push({ kind: 'text', text: 'PHASE1_NATIVE_OK' });
          const { turn } = await rpc.call('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Synthetic phase1 message', textElements: [] }] });
          const terminal = await rpc.completed(turn.id); expect(terminal.params.turn.status).toBe('completed');
          expect(JSON.stringify(terminal)).toContain('PHASE1_NATIVE_OK');
        });
        await check('worker-public-endpoint-and-session-read', async () => {
          const stateDir = join(profileDir, 'workers', 'codex'); await mkdir(stateDir, { recursive: true });
          await writeFile(join(stateDir, 'config.json'), JSON.stringify({ version: 1, toolId: 'codex', options: { binaryPath: binary, codexHome: home, inheritCodexHome: true, appServerRemote: url } }));
          const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_phase1_local_only', secret: 'fake-phase1-secret', tenant: 'feishu' } } });
          provider = await createWorkerProvider(profileDir, 'codex', profile, { profile: 'phase1', rootDir: root, configPath: join(root, 'unused-config.json') });
          worker = await startWorkerServer({ stateDir, agent: provider.agent, sourceId: provider.sourceId, botAppId: 'cli_phase1_local_only', sessions: provider.sessions, manifest: provider.manifest });
          const client = new WorkerClient(stateDir, home, 'cli_phase1_local_only', 'codex');
          expect((await client.listSessions()).some(s => s.nativeId === thread)).toBe(true);
          expect((await client.conversation(thread)).id).toBe(thread);
        });
        const stateDir = join(profileDir, 'workers', 'codex'), client = new WorkerClient(stateDir, home, 'cli_phase1_local_only', 'codex');
        if (worker) {
          await check('worker-message-reply', async () => {
            fixture.plans.push({ kind: 'text', text: 'PHASE1_WORKER_OK' });
            const job = await client.submit({ requestKey: randomUUID(), options: { runId: randomUUID(), threadId: thread, prompt: 'Synthetic worker message', cwd: workspace, model: 'gpt-6.1-sol' } });
            const result = await until(async () => { const s = await client.snapshot(job.id); return !['running', 'accepted'].includes(s.job.status) ? s : undefined; }, 30_000);
            expect(result.job.status).toBe('completed');
            expect(result.events.some(e => e.event.type === 'text' && e.event.delta.includes('PHASE1_WORKER_OK'))).toBe(true);
            expect(rpc.messages.some(m => m.method === 'turn/completed' && JSON.stringify(m.params).includes('PHASE1_WORKER_OK'))).toBe(true);
            const conversation = await client.conversation(thread);
            expect(conversation.turns.find(t => t.input === 'Synthetic phase1 message')?.bridge).toBe(false);
            expect(conversation.turns.find(t => t.input === 'Synthetic worker message')?.bridge).toBe(true);
          });
          await check('queue-preserved-stop-and-automatic-continuation', async () => {
            fixture.plans.push({ kind: 'hold' });
            const { turn } = await rpc.call('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Synthetic held turn', textElements: [] }] });
            await until(() => fixture.held.size > 0);
            const queued = await rpc.call('thread/queue/add', { threadId: thread, input: [{ type: 'text', text: 'Synthetic queued message', textElements: [] }], clientUserMessageId: 'phase1-queue' });
            expect((await rpc.call('thread/queue/list', { threadId: thread })).data.length).toBe(1);
            expect(await client.stopNativeTurn(thread, turn.id, workspace)).toBe(true);
            expect((await rpc.completed(turn.id)).params.turn.status).toBe('interrupted');
            expect((await rpc.call('thread/queue/list', { threadId: thread })).data.length).toBe(1);
            fixture.plans.push({ kind: 'text', text: 'PHASE1_QUEUED_OK' });
            // Do not call queue/start from the test: verify the actual worker's
            // default 15-second maintenance loop resumes exactly the saved head.
            const next = await until(() => rpc.messages.find(m => m.method === 'turn/completed' && m.params?.turn?.id !== turn.id && JSON.stringify(m.params).includes('PHASE1_QUEUED_OK')), 25_000);
            expect(next.params.turn.status).toBe('completed');
            expect((await rpc.call('thread/queue/list', { threadId: thread })).data).toHaveLength(0);
            const ledger = JSON.parse(await readFile(join(stateDir, 'auto-continue.json'), 'utf8'));
            expect(Object.values(ledger.attempts).some((a: any) => a.queueId === queued.queuedSubmission.id && a.confirmed === true)).toBe(true);
          });
          await check('native-question-roundtrip', async () => {
            fixture.plans.push({ kind: 'question' }, { kind: 'text', text: 'PHASE1_ANSWER_OK' });
            const { turn } = await rpc.call('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Ask synthetic choice', textElements: [] }],
              collaborationMode: { mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', developer_instructions: null } } });
            const question = await until(() => rpc.messages.find(m => m.id !== undefined && m.method?.includes('requestUserInput') && m.params?.turnId === turn.id));
            let answered = false;
            try {
              answered = await check('worker-question-discovery-and-answer', async () => {
                const questions = await until(async () => { const q = await client.questions(thread); return q.length ? q : undefined; }, 5000);
                expect(await client.answer(thread, questions[0]!.id, { confirm_path: { answers: ['Yes'] } })).toBe(true);
                return true;
              }) ?? false;
            } finally {
              if (!answered) rpc.respond(question.id, { answers: { confirm_path: { answers: ['Yes'] } } });
            }
            expect((await rpc.completed(turn.id)).params.turn.status).toBe('completed');
          });
        }
      }
    }
    await worker?.close(); worker = undefined;
    await provider?.sessions.close?.(); provider = undefined;
    while (clients.length) await clients.pop()!.close();
    await stopChild(children[0]);
    const token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const tokenFile = join(root, 'transport-token'); await writeFile(tokenFile, token, { mode: 0o600 });
    // Windows may retain an exclusive listener address briefly after exit.
    const authPort = await unusedPort(), authUrl = `ws://127.0.0.1:${authPort}`; launchUrl = authUrl;
    launch(['--ws-auth', 'capability-token', '--ws-token-file', tokenFile], 'authenticated-app-server');
    await check('authenticated-loopback-health', async () => { await until(async () => (await fetch(`http://127.0.0.1:${authPort}/readyz`, { headers: { Authorization: `Bearer ${token}` } })).status === 200); });
    await check('authentication-rejects-missing-token', async () => { await expect(Rpc.connect(authUrl)).rejects.toThrow(/401/); });
    await check('authentication-accepts-bearer-token', async () => { const auth = await Rpc.connect(authUrl, token); clients.push(auth); await auth.call('account/read', { refreshToken: false }); });
    await check('stock-worker-reader-cannot-authenticate-current-limitation', async () => {
      const reader = new CodexThreadReader({ binary, profileStateDir: join(root, 'auth-reader'), codexHome: home, sharedServer: true, remote: authUrl, timeoutMs: 3000 });
      try { await expect(reader.connect()).rejects.toThrow(/401/); } finally { await reader.stop(); }
    });
  } finally {
    await worker?.close().catch(() => {}); await provider?.sessions.close?.().catch(() => {});
    for (const rpc of clients) await rpc.close().catch(() => {});
    for (const child of children) await stopChild(child); await fixture.close();
    for (const log of logs) log.end();
    const report = { phase: 1, binaryVersion: execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
      root, model: 'localhost deterministic SSE fixture (no OpenAI inference)', productionTouched: false, desktopTouched: false,
      limitations: ['Desktop UI, desktop MCP/tool injection and real model login are phase 2, not tested here.',
        'The current stock worker reader has no bearer-token option; protected WebSocket handshake is not supported by that reader.'],
      mockModelRequests: fixture.requests, checks, generatedAt: new Date().toISOString(), cleanup: { testChildrenStopped: children.every(c => c.exitCode !== null || c.signalCode !== null) } };
    await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(`PHASE1_REPORT=${reportPath}`);
  }
  expect(children.every(c => c.exitCode !== null || c.signalCode !== null), 'Test processes must be stopped').toBe(true);
  expect(checks.filter(c => c.status === 'failed'), 'See phase1 report for actual integration failures').toEqual([]);
}, 180_000);
