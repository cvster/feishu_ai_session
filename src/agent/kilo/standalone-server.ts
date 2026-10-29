import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv } from '../lark-channel-env';
import type { KiloOptions } from './client';

/** A lease on the shared standalone backend; sessions differ only by the `directory` query. */
export interface KiloStandaloneLease { url: string; authorization: string; exited: Promise<void>; release(): void }

interface Entry { url: string; authorization: string; users: number; exited: Promise<void>; stop(): void; idle?: NodeJS.Timeout }

// One `kilo serve` per binary and database for the whole process: a per-session or per-client
// backend leaks a native engine (~400MB) for every conversation the worker ever touches.
const servers = new Map<string, Entry>();
const starting = new Map<string, Promise<Entry>>();
const DEFAULT_IDLE_MS = 5 * 60_000;

function idleMs(): number {
  const raw = process.env.LARK_CHANNEL_KILO_IDLE_MS;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MS;
}

function serverKey(options: KiloOptions, command: { binary: string; args: readonly string[] }): string {
  return JSON.stringify([command.binary, command.args, options.dataHome ? resolve(options.dataHome) : '', buildLarkChannelEnv(options.larkChannel)]);
}

/** Returns the shared backend, starting it on first use; every acquired lease must be released. */
export async function acquireKiloStandaloneServer(
  options: KiloOptions, cwd: string | undefined, command: { binary: string; args: string[] },
): Promise<KiloStandaloneLease> {
  const key = serverKey(options, command);
  let entry = servers.get(key);
  if (!entry) {
    let pending = starting.get(key);
    if (!pending) {
      pending = start(key, options, cwd, command).finally(() => starting.delete(key));
      starting.set(key, pending);
    }
    entry = await pending;
  }
  const server = entry;
  if (server.idle) { clearTimeout(server.idle); server.idle = undefined; }
  server.users += 1;
  let released = false;
  return {
    url: server.url, authorization: server.authorization, exited: server.exited,
    release: () => {
      if (released) return; released = true;
      server.users -= 1;
      if (server.users > 0) return;
      const idle = idleMs();
      if (idle > 0) {
        server.idle = setTimeout(() => { if (servers.get(key) === server) servers.delete(key); server.stop(); }, idle);
        server.idle.unref();
        return;
      }
      if (servers.get(key) === server) servers.delete(key);
      server.stop();
    },
  };
}

/** Stops every shared backend; used when the worker shuts down. */
export function closeKiloStandaloneServers(): void {
  for (const [key, server] of servers) { servers.delete(key); server.stop(); }
}

// A warm backend must not outlive the worker that owns it, or a restart leaves an orphan engine.
process.once('exit', () => { for (const server of servers.values()) server.stop(); });

async function start(
  key: string, options: KiloOptions, cwd: string | undefined, command: { binary: string; args: string[] },
): Promise<Entry> {
  const password = randomBytes(32).toString('hex');
  const authorization = `Basic ${Buffer.from(`kilo:${password}`).toString('base64')}`;
  const child = spawnProcess(command.binary, [...command.args, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd, env: mergeProcessEnv(process.env, { ...buildLarkChannelEnv(options.larkChannel),
      KILO_SERVER_USERNAME: 'kilo', KILO_SERVER_PASSWORD: password,
      ...(options.dataHome ? { XDG_DATA_HOME: resolve(options.dataHome) } : {}),
    }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', () => {}); // Native diagnostics may contain provider secrets; never forward them.
  const lines = createInterface({ input: child.stdout! });
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
  };
  let finishExit!: () => void;
  const exited = new Promise<void>(done => { finishExit = done; });
  const entry: Entry = { url: '', authorization, users: 0, exited, stop };
  child.once('close', () => {
    lines.close(); finishExit();
    if (servers.get(key) === entry) servers.delete(key);
  });
  entry.url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => { reject(new Error('Kilo 服务启动超时')); stop(); }, 30_000);
    const finish = (error?: Error, url?: string) => { clearTimeout(timer); error ? reject(error) : resolveReady(url!); };
    lines.on('line', line => {
      const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match) finish(undefined, match[1]);
    });
    child.once('error', () => finish(new Error('Kilo 服务无法启动，请检查可执行文件')));
    child.once('close', () => finish(new Error('Kilo 服务已退出')));
  });
  servers.set(key, entry);
  return entry;
}
