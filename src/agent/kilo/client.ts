import { request as httpRequest, type ClientRequest } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findKiloEditorServer, type KiloEditorServer, type KiloClientMode } from './editor-server';
import { acquireKiloStandaloneServer, type KiloStandaloneLease } from './standalone-server';
import type { LarkChannelEnvContext } from '../lark-channel-env';

export interface KiloOptions { binary?: string; args?: readonly string[]; dataHome?: string; editorSync?: boolean; client?: KiloClientMode; larkChannel?: LarkChannelEnvContext }
export function kiloStorageDir(options: KiloOptions = {}): string {
  return resolve(join(options.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'kilo'));
}
export function kiloCommand(options: KiloOptions = {}): { binary: string; args: string[] } {
  if (options.binary || process.env.LARK_CHANNEL_KILO_BIN) return { binary: options.binary ?? process.env.LARK_CHANNEL_KILO_BIN!, args: [...(options.args ?? [])] };
  if (options.client === 'app') {
    for (const root of ['/usr/lib/kilo-desktop', '/opt/kilo-desktop']) {
      const dir = join(root, 'resources/kilo');
      let names: string[]; try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) { const binary = join(dir, name, 'bin/kilo'); if (existsSync(binary)) return { binary, args: [...(options.args ?? [])] }; }
    }
  }
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
  private authorization = '';
  private lease?: KiloStandaloneLease;
  private readonly ready: Promise<string>;
  private readonly streams = new Set<ClientRequest>();
  private closed = false;
  readonly exited: Promise<void>;
  private exit!: () => void;
  private attached?: KiloEditorServer;
  private readonly mode: KiloClientMode;
  private readonly validated = new Set<string>();
  constructor(options: KiloOptions = {}, cwd?: string, sessionId?: string) {
    if (options.client !== undefined && options.client !== 'vscode' && options.client !== 'app') throw new Error('Kilo client 必须配置为 vscode 或 app');
    this.mode = options.client ?? 'vscode';
    this.exited = new Promise(done => { this.exit = done; });
    this.ready = this.connect(options, cwd, sessionId);
    void this.ready.catch(() => {}); // Preserve the specific discovery/startup rejection for request callers.
  }
  private async connect(options: KiloOptions, cwd?: string, sessionId?: string): Promise<string> {
    const command = kiloCommand(options);
    const editor = (this.mode === 'app' || (options.editorSync !== false && !command.args.length))
      ? await findKiloEditorServer(command.binary, cwd, options.dataHome, {}, sessionId, this.mode) : undefined;
    if (this.closed) throw new Error('Kilo 连接已关闭');
    if (editor && editor.client !== (this.mode === 'app' ? 'desktop' : 'vscode')) throw new Error('Kilo 后端与配置模式不匹配，不处理 Kilo App 与插件的跨模式会话');
    if (editor) { this.attached = editor; this.authorization = editor.authorization; return editor.url; }
    if (this.mode === 'app') throw new Error('Kilo App 后端未启动；未切换到 VS Code 或 CLI');
    // Share one standalone backend per binary/database instead of spawning one per session.
    const lease = await acquireKiloStandaloneServer(options, cwd, command);
    if (this.closed) { lease.release(); throw new Error('Kilo 连接已关闭'); }
    this.lease = lease;
    this.authorization = lease.authorization;
    void lease.exited.then(() => this.exit());
    return lease.url;
  }
  async sessionCreationMetadata(): Promise<Record<string, unknown> | undefined> {
    await this.ready;
    if (this.mode === 'app' && !this.attached?.sessionMetadata) throw new Error('请先在 Kilo App 为此项目创建会话，确定工作区后再创建桥接会话');
    return this.attached?.sessionMetadata;
  }
  async request<T = any>(method: string, path: string, body?: unknown, cwd?: string): Promise<T> {
    const url = new URL(path, await this.ready);
    const nativeId = /^\/session\/(ses[A-Za-z0-9_-]+)(?:[/?]|$)/.exec(path)?.[1];
    if (nativeId && !this.validated.has(nativeId) && !(method === 'GET' && path === '/session/' + nativeId)) await this.request('GET', '/session/' + kiloSessionId(nativeId), undefined, cwd);
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
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (nativeId && method === 'GET' && path === '/session/' + nativeId) {
              if (value?.id !== nativeId || !!value?.metadata?.['kilo-desktop'] !== (this.mode === 'app')) throw new Error(this.mode === 'app' ? '当前配置仅支持 Kilo App 会话' : '当前配置仅支持 VS Code 会话，不处理 Kilo App 会话');
              this.validated.add(nativeId!);
            }
            // A fork is a new session created by the selected backend. App metadata
            // may need restoring before the first read; never whitelist arbitrary IDs.
            if (method === 'POST' && /^\/session\/[^/]+\/fork$/.test(path) && this.validated.has(nativeId!) && value?.id !== nativeId && typeof value?.id === 'string' && value.directory === cwd) this.validated.add(kiloSessionId(value.id));
            resolveRequest(value as T);
          }
          catch (error) { reject(error instanceof Error ? error : new Error('Kilo 返回了无效的协议数据')); }
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
    this.lease?.release();
    this.exit();
  }
}
