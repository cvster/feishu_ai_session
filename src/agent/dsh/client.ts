import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';

export interface DshOptions { binary?: string; args?: readonly string[]; homeDir?: string; larkChannel?: LarkChannelEnvContext }
export function dshCommand(options: DshOptions = {}) { return { binary: options.binary ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh', args: [...(options.args ?? [])] }; }
export function dshStorageDir(options: DshOptions = {}): string { return resolve(options.homeDir ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))); }
export function dshSessionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) throw new Error('DSH 会话 ID 无效');
  return id;
}
export class DshRpcError extends Error {
  constructor(readonly code: string, endpoint: string) { super(`DSH ${endpoint} 拒绝请求（${code}）；未自动重发`); }
}

/** Owns one authenticated loopback runtime; never attaches to the user's Web/desktop process. */
export class DshClient {
  private child;
  private closed = false;
  private ready: Promise<{ base: string; cookie: string }>;
  private sockets = new Set<WebSocket>();
  readonly exited: Promise<void>;
  constructor(options: DshOptions = {}, cwd?: string) {
    const command = dshCommand(options);
    this.child = spawnProcess(command.binary, [...command.args, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd, env: mergeProcessEnv(process.env, { ...buildLarkChannelEnv(options.larkChannel), DSH_HOME: dshStorageDir(options) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr!.on('data', () => {}); // Native logs can contain provider credentials or launch tokens.
    const lines = createInterface({ input: this.child.stdout! });
    this.exited = new Promise(done => { this.child.once('error', () => done()); this.child.once('close', () => { lines.close(); done(); }); });
    this.ready = new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => { reject(new Error('DSH 启动超时')); void this.close(); }, 45_000);
      const finish = (error?: Error, url?: string) => { clearTimeout(timer); error ? reject(error) : accept(url!); };
      lines.on('line', line => { const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(line); if (match) finish(undefined, match[1]); });
      this.child.once('error', () => finish(new Error('DSH 无法启动，请检查安装及 Node 版本')));
      this.child.once('close', () => finish(new Error('DSH 原生服务已退出')));
    }).then(async url => {
      const response = await this.http(url);
      const cookie = response.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ');
      if (![302, 303].includes(response.status) || !cookie) throw new Error('DSH 原生身份握手失败');
      return { base: new URL(url).origin, cookie };
    });
    void this.ready.catch(() => {});
  }
  private http(url: string, body?: unknown, cookie?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((accept, reject) => {
      const req = httpRequest(url, { agent: false, method: body === undefined ? 'GET' : 'POST', headers: {
        'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
      } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(new Error('DSH 响应过大')); else chunks.push(chunk); });
        res.once('error', () => reject(new Error('DSH 响应连接断开；未自动重发')));
        res.once('end', () => accept({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(30_000, () => req.destroy(new Error('DSH 请求超时')));
      req.once('error', () => reject(new Error('DSH 连接失败或超时；执行状态未确认，未自动重发')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async request<T = any>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!/^[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/.test(endpoint)) throw new Error('Invalid DSH endpoint');
    const { base, cookie } = await this.ready, rpcId = randomUUID();
    const response = await this.http(`${base}/api/${endpoint}`, { type: 'client-request', rpcId, method: endpoint, payload: { args } }, cookie);
    if (response.status !== 200) throw new DshRpcError(`HTTP_${response.status}`, endpoint);
    let result: any;
    try { result = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('DSH 返回了无效 JSON'); }
    if (result.type !== 'server-response' || result.rpcId !== rpcId) throw new Error('DSH 返回了不匹配的协议回执');
    if (result.result?.ok !== true) throw new DshRpcError(typeof result.result?.error?.code === 'string' && /^[\w/-]{1,100}$/.test(result.result.error.code) ? result.result.error.code : 'UNKNOWN', endpoint);
    return result.result.value as T;
  }
  async subscribe(endpoint: string, args: Record<string, unknown>, receive: (value: any) => void, disconnected: () => void): Promise<() => void> {
    const { base, cookie } = await this.ready, streamId = randomUUID();
    return new Promise((accept, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { Cookie: cookie }, maxPayload: 32 * 1024 * 1024 });
      this.sockets.add(socket); let established = false, deliberate = false;
      const close = () => { deliberate = true; clearTimeout(timer); this.sockets.delete(socket); socket.terminate(); };
      const timer = setTimeout(() => { close(); reject(new Error('DSH 事件订阅超时')); }, 30_000);
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })));
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.streamId !== streamId) return;
          if (frame.type !== 'item') throw new Error('DSH 事件流结束或拒绝');
          receive(frame.value);
          if (!established) { established = true; clearTimeout(timer); accept(close); }
        } catch { close(); if (established) disconnected(); else reject(new Error('DSH 事件协议不兼容或订阅被拒绝')); }
      });
      socket.once('error', () => { if (!established) { close(); reject(new Error('DSH 事件连接失败')); } });
      socket.once('close', () => {
        clearTimeout(timer); this.sockets.delete(socket);
        if (!established) reject(new Error('DSH 事件连接关闭'));
        else if (!deliberate && !this.closed) disconnected();
      });
    });
  }
  async snapshot(endpoint: string, args: Record<string, unknown> = {}): Promise<any> {
    let first: any;
    const close = await this.subscribe(endpoint, args, value => { first ??= value; }, () => {});
    close(); return first;
  }
  async session(id: string, maxMessages = 100): Promise<any> {
    const snapshot = await this.snapshot('session/follow', { request: { address: { kind: 'session', sessionId: dshSessionId(id) }, maxMessages } });
    if (snapshot?.type !== 'snapshot' || snapshot.header?.id !== id) throw new Error('DSH 返回了不匹配的会话');
    return snapshot;
  }
  async roster(): Promise<{ rows: any[]; archived: Set<string> }> {
    const [list, workspace] = await Promise.all([this.request('session/list', { _request: {} }), this.snapshot('workspace/follow')]);
    if (!Array.isArray(list?.items) || workspace?.type !== 'baseline' || !Array.isArray(workspace.value?.archivedSessionIds)) throw new Error('DSH 会话目录格式不兼容');
    return { rows: list.items, archived: new Set(workspace.value.archivedSessionIds) };
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const socket of this.sockets) socket.terminate();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000); timer.unref();
    await this.exited; clearTimeout(timer);
  }
}
