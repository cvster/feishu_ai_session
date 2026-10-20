import { request as httpRequest, type ClientRequest } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { findKiloEditorServer, type KiloEditorServer } from './editor-server';

export interface KiloOptions { binary?: string; args?: readonly string[]; dataHome?: string; editorSync?: boolean; larkChannel?: LarkChannelEnvContext }
export function kiloStorageDir(options: KiloOptions = {}): string {
  return resolve(join(options.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'kilo'));
}
export function kiloCommand(options: KiloOptions = {}): { binary: string; args: string[] } {
  if (options.binary || process.env.LARK_CHANNEL_KILO_BIN) return { binary: options.binary ?? process.env.LARK_CHANNEL_KILO_BIN!, args: [...(options.args ?? [])] };
  // Use the installed extension's bundled engine, without requiring a second installation.
  for (const root of [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.vscode-server', 'extensions'), join(homedir(), '.vscode-insiders', 'extensions')]) {
    let names: string[]; try { names = readdirSync(root); } catch { continue; }
    for (const name of names.filter(n => /^kilocode\.kilo-code-\d/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const binary = join(root, name, 'bin', process.platform === 'win32' ? 'kilo.exe' : 'kilo');
      if (existsSync(binary)) return { binary, args: [...(options.args ?? [])] };
    }
  }
  return { binary: 'kilo', args: [...(options.args ?? [])] };
}
export class KiloHttpError extends Error { constructor(readonly status: number, method: string, path: string) { super(`Kilo ${method} ${path.split('?')[0]} returned HTTP ${status}`); } }
export function kiloSessionId(id: string): string {
  if (!/^ses[A-Za-z0-9_-]+$/.test(id)) throw new Error('Kilo 会话 ID 无效');
  return id;
}

/** Prefers the matching editor backend for realtime UI events; never owns or stops that process. */
export class KiloClient {
  private child?: ReturnType<typeof spawnProcess>;
  private authorization = `Basic ${Buffer.from(`kilo:${randomBytes(32).toString('hex')}`).toString('base64')}`;
  private readonly ready: Promise<string>;
  private readonly streams = new Set<ClientRequest>();
  private closed = false;
  readonly exited: Promise<void>;
  private exit!: () => void;
  private attached?: KiloEditorServer;
  constructor(options: KiloOptions = {}, cwd?: string, sessionId?: string) {
    this.exited = new Promise(done => { this.exit = done; });
    this.ready = this.connect(options, cwd, sessionId);
    void this.ready.catch(() => {}); // Preserve the specific discovery/startup rejection for request callers.
  }
  private async connect(options: KiloOptions, cwd?: string, sessionId?: string): Promise<string> {
    const command = kiloCommand(options);
    const editor = options.editorSync !== false && !command.args.length
      ? await findKiloEditorServer(command.binary, cwd, options.dataHome, {}, sessionId) : undefined;
    if (this.closed) throw new Error('Kilo 连接已关闭');
    if (editor) { this.attached = editor; this.authorization = editor.authorization; return editor.url; }
    this.child = spawnProcess(command.binary, [...command.args, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd, env: mergeProcessEnv(process.env, { ...buildLarkChannelEnv(options.larkChannel),
        KILO_SERVER_USERNAME: 'kilo', KILO_SERVER_PASSWORD: Buffer.from(this.authorization.slice(6), 'base64').toString().slice(5),
        ...(options.dataHome ? { XDG_DATA_HOME: resolve(options.dataHome) } : {}),
      }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr!.on('data', () => {}); // Native diagnostics may contain provider secrets; never forward them.
    const lines = createInterface({ input: this.child.stdout! });
    const ready = new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => { reject(new Error('Kilo 服务启动超时')); void this.close(); }, 30_000);
      const finish = (error?: Error, url?: string) => { clearTimeout(timer); error ? reject(error) : resolveReady(url!); };
      lines.on('line', line => {
        const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
        if (match) finish(undefined, match[1]);
      });
      this.child!.once('error', () => finish(new Error('Kilo 服务无法启动，请检查可执行文件')));
      this.child!.once('close', () => finish(new Error('Kilo 服务已退出')));
    });
    this.child.once('error', () => this.exit());
    this.child.once('close', () => { lines.close(); this.exit(); });
    return ready;
  }
  async sessionCreationMetadata(): Promise<Record<string, unknown> | undefined> {
    await this.ready;
    if (this.attached?.client === 'desktop' && !this.attached.sessionMetadata) throw new Error('请先在 Kilo 桌面 App 为此项目创建一个会话，再从飞书关联或创建，确保新会话可在桌面工作区显示。');
    return this.attached?.sessionMetadata;
  }
  async request<T = any>(method: string, path: string, body?: unknown, cwd?: string): Promise<T> {
    const url = new URL(path, await this.ready);
    if (cwd) url.searchParams.set('directory', cwd);
    return new Promise((resolveRequest, reject) => {
      const req = httpRequest(url, { method, agent: false, headers: { Authorization: this.authorization, 'Content-Type': 'application/json' } }, res => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new KiloHttpError(res.statusCode ?? 0, method, path)); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) { req.destroy(new Error('Kilo 响应过大')); return; }
          chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          if (res.statusCode === 204) { resolveRequest(undefined as T); return; }
          try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { reject(new Error('Kilo 返回了无效的协议数据')); }
        });
      });
      req.setTimeout(30_000, () => req.destroy(new Error(`Kilo ${method} 请求超时；未自动重发`)));
      req.once('error', () => reject(new Error(`Kilo ${method} ${path.split('?')[0]} 连接失败；未自动重发`)));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async subscribe(cwd: string, receive: (event: any) => void, disconnected: () => void): Promise<void> {
    const url = new URL('/event', await this.ready); url.searchParams.set('directory', cwd);
    return new Promise((resolveStream, reject) => {
      let established = false, ended = false;
      const finish = () => {
        if (ended) return; ended = true; this.streams.delete(req);
        if (established && !this.closed) disconnected();
      };
      const req = httpRequest(url, { agent: false, headers: { Authorization: this.authorization } }, res => {
        req.setTimeout(0);
        if (res.statusCode !== 200 || !res.headers['content-type']?.includes('text/event-stream')) {
          res.resume(); reject(new Error('Kilo 事件订阅失败')); finish(); return;
        }
        established = true; resolveStream();
        const decoder = new StringDecoder('utf8'); let buffer = '';
        res.on('data', (chunk: Buffer) => {
          try {
            buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, '\n');
            if (buffer.length > 32 * 1024 * 1024) throw new Error('Event too large');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) receive(JSON.parse(data));
            }
          } catch { req.destroy(); finish(); }
        });
        res.once('error', finish); res.once('end', finish); res.once('close', finish);
      });
      this.streams.add(req);
      req.setTimeout(30_000, () => req.destroy(new Error('Kilo 事件订阅超时')));
      req.once('error', () => { reject(new Error('Kilo 事件连接失败')); finish(); });
      req.end();
    });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const req of this.streams) req.destroy();
    if (!this.child) { this.exit(); return; }
    this.child.kill('SIGTERM');
    const child = this.child;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
    await this.exited; clearTimeout(timer);
  }
}
