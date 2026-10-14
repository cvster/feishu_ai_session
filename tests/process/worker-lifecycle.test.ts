import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'tsup';
import { expect, it, vi } from 'vitest';
import { createRootConfig } from '../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { WorkerClient } from '../../src/worker/client';
import { jobIdFor } from '../../src/worker/store';

it.skipIf(process.platform !== 'linux')('keeps the real Claude child alive when a bridge process exits and reconnects a new bridge to the same task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-process-'));
  const workspace = join(dir, 'workspace'); await mkdir(workspace);
  const claudeHome = join(dir, 'claude-home'); await mkdir(claudeHome);
  const binary = join(dir, 'fake-claude.mjs');
  const finishFile = join(dir, 'finish'), traceFile = join(dir, 'trace.json'), heartbeat = join(dir, 'heartbeat');
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.261 (Claude Code)'); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const index = args.indexOf('--session-id') >= 0 ? args.indexOf('--session-id') : args.indexOf('--resume');
const nativeId = args[index + 1];
writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ pid: process.pid, parent: process.ppid, cwd: process.cwd(), nativeId, prompt }));
appendFileSync(${JSON.stringify(join(dir, 'invocations'))}, 'run\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: nativeId, cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'before bridge exit\\n' }] } }));
const timer = setInterval(() => {
  writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()));
  if (existsSync(${JSON.stringify(finishFile)})) {
    clearInterval(timer);
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after reconnect' }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: nativeId })); process.exit(0);
  }
}, 50);
`); await chmod(binary, 0o755);
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true },
    accounts: { app: { id: 'cli_worker_test', secret: 'fixture-only', tenant: 'feishu' } } });
  const configPath = join(dir, 'config.json'); await writeFile(configPath, JSON.stringify(createRootConfig('worker-test', profile)));
  const source = resolve('src'), observerEntry = join(dir, 'observer.ts');
  const options = { runId: 'bridge-run', requestKey: 'one-feishu-message', prompt: 'real test request', cwd: workspace,
    initialSessionId: '50d06950-8fa4-4a6c-a132-77158c27c9ee' };
  const stateDir = join(dir, 'profiles', 'worker-test', 'execution-worker');
  await writeFile(observerEntry, `
import { WorkerClient } from ${JSON.stringify(join(source, 'worker/client.ts'))};
import { DurableClaudeAdapter } from ${JSON.stringify(join(source, 'worker/adapter.ts'))};
const client = new WorkerClient(${JSON.stringify(stateDir)}, ${JSON.stringify(claudeHome)}, 'cli_worker_test');
const adapter = new DurableClaudeAdapter(client, { id: 'claude', displayName: 'Claude Code', isAvailable: async () => true, run: () => { throw Error('must use worker'); } });
const run = process.argv[2] ? adapter.observe(process.argv[2]) : adapter.run(${JSON.stringify(options)});
for await (const event of run.events) console.log(JSON.stringify(event));
`);
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  const buildDir = join(dir, 'build');
  await build({ entry: { worker: join(source, 'cli/index.ts'), observer: observerEntry }, outDir: buildDir, format: ['esm'],
    platform: 'node', target: 'node20', dts: false, splitting: false, clean: false, silent: true, config: false });
  const children: ChildProcess[] = [];
  const launch = (file: string, args: string[]) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, LARK_CHANNEL_CLAUDE_BIN: binary }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let output = '', errors = '';
    child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
    return { child, output: () => output, errors: () => errors };
  };
  try {
    const worker = launch(join(buildDir, 'worker.js'), ['worker', 'run', '--profile', 'worker-test', '--config', configPath]);
    const client = new WorkerClient(stateDir, claudeHome, 'cli_worker_test');
    await vi.waitFor(async () => { if (worker.child.exitCode !== null) throw Error(worker.errors()); await client.health(); }, { timeout: 5000 });
    const bridge = launch(join(buildDir, 'observer.js'), []);
    await vi.waitFor(() => expect(bridge.output()).toContain('before bridge exit'), { timeout: 5000 });
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    expect(trace.parent).toBe(worker.child.pid); expect(trace.parent).not.toBe(bridge.child.pid);
    expect(trace.nativeId).toBe(options.initialSessionId); expect(trace.prompt).toBe(options.prompt);
    const exited = once(bridge.child, 'exit'); bridge.child.kill('SIGTERM'); await exited;
    const before = await readFile(heartbeat, 'utf8');
    await vi.waitFor(async () => expect(await readFile(heartbeat, 'utf8')).not.toBe(before));
    expect((await client.snapshot(jobIdFor(options.requestKey))).job.status).toBe('running');
    const reconnected = launch(join(buildDir, 'observer.js'), [jobIdFor(options.requestKey)]);
    await vi.waitFor(() => expect(reconnected.output()).toContain('before bridge exit'), { timeout: 5000 });
    await writeFile(finishFile, 'finish');
    await vi.waitFor(() => expect(reconnected.child.exitCode).toBe(0), { timeout: 5000 });
    expect(reconnected.output()).toContain('after reconnect');
    expect((await readFile(join(dir, 'invocations'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await client.submit({ requestKey: options.requestKey, options })).status).toBe('completed');
  } finally {
    await writeFile(finishFile, 'finish');
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
