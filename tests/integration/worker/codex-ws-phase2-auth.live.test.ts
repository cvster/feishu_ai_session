import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CodexThreadReader } from '../../../src/session/codex-thread-reader';

// Opt-in: real installed Codex app-server behind a capability-token WebSocket.
// Verifies the worker's reader can authenticate and fails closed without a token.
const enabled = process.env.BRIDGE_CODEX_WS_PHASE2 === '1';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T | Promise<T>, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value as NonNullable<T>; } catch (error) { last = error; }
    await delay(250);
  }
  throw last instanceof Error ? last : new Error(`Condition timed out after ${timeout}ms`);
}
async function unusedPort() {
  return await new Promise<number>((resolve) => {
    const server = createServer(); server.listen(0, '127.0.0.1');
    server.once('listening', () => { const address = server.address(); server.close(() => resolve((address as { port: number }).port)); });
  });
}
async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([closed, delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

it.skipIf(!enabled)('phase 2: worker reader authenticates to a capability-token app-server', async () => {
  const binary = process.env.BRIDGE_CODEX_WS_PHASE2_BIN;
  if (!binary) throw new Error('Set BRIDGE_CODEX_WS_PHASE2_BIN to the installed Codex executable');
  const root = await mkdtemp(join(tmpdir(), 'codex-ws-phase2-'));
  const home = join(root, 'codex-home'), workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  await writeFile(join(home, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "read-only"\n[analytics]\nenabled = false\n');
  const token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
  const tokenFile = join(root, 'transport-token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const port = await unusedPort(), url = `ws://127.0.0.1:${port}`;
  const reportPath = process.env.BRIDGE_CODEX_WS_PHASE2_REPORT ?? join(root, 'report.json');
  const log = createWriteStream(join(root, 'app-server.log'));
  const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, 'sqlite'), RUST_LOG: 'warn' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN', 'CODEX_QUEUE_REMOTE', 'CODEX_APP_SERVER_WS_URL']) delete env[key];
  const check = async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    try { const value = await action(); checks.push({ name, status: 'passed' }); return value; }
    catch (error) { checks.push({ name, status: 'failed', detail: String(error).slice(0, 1200) }); return undefined; }
  };
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile],
      { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });

    await check('authenticated-server-ready', async () => {
      await until(async () => (await fetch(`http://127.0.0.1:${port}/readyz`, { headers: { Authorization: `Bearer ${token}` } })).status === 200);
    });
    await check('unauthenticated-reader-rejected', async () => {
      const reader = new CodexThreadReader({ binary, profileStateDir: join(root, 'plain'), remote: url, sharedServer: true, timeoutMs: 4000 });
      try { await reader.connect(); throw new Error('an unauthenticated reader must not connect'); }
      catch (error) { if (!/401|Unauthorized/i.test(String(error))) throw error; }
      finally { await reader.stop(); }
    });
    await check('authenticated-reader-reads-sessions', async () => {
      const reader = new CodexThreadReader({ binary, profileStateDir: join(root, 'auth'), codexHome: home, remote: url, sharedServer: true,
        passive: true, remoteTokenEnv: 'BRIDGE_PHASE2_TOKEN', env: { BRIDGE_PHASE2_TOKEN: token }, timeoutMs: 10_000 });
      try {
        await reader.connect();
        const threads = await reader.listRecentThreads(5);
        expect(Array.isArray(threads)).toBe(true);
        const account = await reader.rpc('account/read', { refreshToken: false });
        expect(account.account).toBeNull();
      } finally { await reader.stop(); }
    });
    await check('missing-token-fails-closed', async () => {
      const reader = new CodexThreadReader({ binary, profileStateDir: join(root, 'empty'), codexHome: home, remote: url,
        sharedServer: true, remoteTokenEnv: 'BRIDGE_PHASE2_MISSING', env: {}, timeoutMs: 4000 });
      try { await reader.connect(); throw new Error('a missing bearer token must not connect'); }
      catch (error) { if (!/BRIDGE_PHASE2_MISSING/.test(String(error))) throw error; }
      finally { await reader.stop(); }
    });
  } finally {
    await stopChild(child); log.end();
    const report = { phase: 2, root, url, productionTouched: false, desktopTouched: false,
      binaryVersion: execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
      checks, tokenInReport: false, generatedAt: new Date().toISOString(), cleanup: { appServerStopped: !child || child.exitCode !== null } };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`PHASE2_REPORT=${reportPath}`);
  }
  expect(checks.filter((check) => check.status === 'failed')).toEqual([]);
  expect(await readFile(join(root, 'app-server.log'), 'utf8').catch(() => '')).not.toContain(token);
}, 120_000);
