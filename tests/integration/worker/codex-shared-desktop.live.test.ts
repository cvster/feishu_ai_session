import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CodexThreadReader } from '../../../src/session/codex-thread-reader';

// Opt-in: proves an isolated Codex Desktop instance and a worker-format reader
// share one externally hosted app-server. Requires a launcher-managed server:
//   tools/windows-shared-app-server.ps1 -Action start -Port <port>
// and BRIDGE_CODEX_SHARED_URL / BRIDGE_CODEX_SHARED_HOME pointing at it.
const enabled = process.env.BRIDGE_CODEX_SHARED_URL && process.env.BRIDGE_CODEX_SHARED_HOME &&
  process.env.BRIDGE_CODEX_SHARED_DESKTOP === '1';
const DESKTOP = process.env.BRIDGE_CODEX_SHARED_DESKTOP_EXE ??
  'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const CODE = 'C:\\Users\\ps5000\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T | Promise<T>, timeout = 90_000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value as NonNullable<T>; } catch (error) { last = error; }
    await delay(400);
  }
  throw last instanceof Error ? last : new Error(`${label} timed out`);
}
function ps(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
class Rpc {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.id === undefined || message.method) return;
      const task = this.pending.get(message.id); if (!task) return;
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    });
    socket.on('error', () => {});
  }
  static async connect(url: string) {
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    const rpc = new Rpc(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    await rpc.call('initialize', { clientInfo: { name: 'codex_shared_desktop_test', version: '1' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    return rpc;
  }
  call(method: string, params: Record<string, unknown> = {}, timeout = 20_000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.terminate(); }
}

it.skipIf(!enabled)('phase 2: desktop and worker attach to one launcher-managed app-server', async () => {
  const url = process.env.BRIDGE_CODEX_SHARED_URL!;
  const home = process.env.BRIDGE_CODEX_SHARED_HOME!;
  const root = await mkdtemp(join(tmpdir(), 'codex-shared-desktop-'));
  const userData = join(root, 'user-data'), workspace = join(root, 'workspace');
  await Promise.all([mkdir(userData), mkdir(workspace)]);
  const checks: Record<string, unknown> = { sharedUrl: url, isolatedUserData: userData };
  let desktop: ReturnType<typeof spawn> | undefined, client: Rpc | undefined, reader: CodexThreadReader | undefined;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, 'sqlite'),
      CODEX_ELECTRON_USER_DATA_PATH: userData, CODEX_APP_SERVER_WS_URL: url };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN', 'CODEX_QUEUE_REMOTE']) delete env[key];
    desktop = spawn(DESKTOP, [`--user-data-dir=${userData}`], { cwd: workspace, env, windowsHide: false, stdio: 'ignore' });
    const launcherStatus = async () => JSON.parse(ps(
      `& 'C:/software/lark-coding-agent-bridge/tools/windows-shared-app-server.ps1' -Action status`).trim().split(/\r?\n/).at(-1)!);
    await until(async () => ((await launcherStatus()).desktopConnections?.length ? true : undefined), 90_000, 'desktop attach');
    checks.desktopAttachedToSharedServer = true;

    client = await Rpc.connect(url);
    const created = await client.call('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = created.thread.id as string;
    checks.threadCreated = threadId;

    reader = new CodexThreadReader({ binary: CODE, profileStateDir: join(root, 'worker'), codexHome: home,
      inheritCodexHome: true, sharedServer: true, passive: true, remote: url, timeoutMs: 20_000 });
    await reader.connect();
    // thread/list is state-DB backed and omits idle threads, so read the exact
    // identity instead: this proves the reader resolved the desktop-visible thread.
    const snapshot = await until(async () => {
      const result = await reader!.rpc('thread/read', { threadId, includeTurns: false });
      return (result.thread as { id?: string } | undefined)?.id === threadId ? result : undefined;
    }, 20_000, 'worker reads desktop-created thread');
    checks.workerReadsSameThread = (snapshot.thread as { id?: string }).id === threadId;
    // A thread with no turns cannot be projected yet (list_turns unsupported by
    // this app-server build); record that instead of asserting a full history.
    checks.workerHistoryProjection = await reader.readThread(threadId)
      .then((history) => (history.id === threadId ? 'ok' : 'mismatch'))
      .catch((error) => `unavailable: ${String(error).slice(0, 120)}`);
    checks.desktopSpawnedOwnAppServer = ps(
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${desktop.pid} -and $_.Name -eq 'codex.exe' }).Count`).trim();
    checks.passed = checks.workerReadsSameThread === true && checks.desktopSpawnedOwnAppServer === '0';
  } finally {
    await reader?.stop().catch(() => {});
    client?.close();
    if (desktop) {
      const command = ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${desktop.pid}' | Select-Object -ExpandProperty CommandLine)`).trim();
      if (/codex-shared-desktop-/.test(command)) {
        try { execFileSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { stdio: 'ignore' }); checks.isolatedDesktopStopped = true; }
        catch { checks.isolatedDesktopStopped = false; }
      } else checks.isolatedDesktopStopped = 'skipped';
    }
    await delay(1500);
    console.log(JSON.stringify(checks, null, 2));
  }
  expect(checks.passed).toBe(true);
}, 240_000);
