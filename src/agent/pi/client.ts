import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';

export interface PiOptions { binary?: string; args?: readonly string[]; agentDir?: string; larkChannel?: LarkChannelEnvContext }
export const piCommand = (options: PiOptions = {}) => ({ binary: options.binary ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi', args: [...options.args ?? []] });
export const piStorageDir = (options: PiOptions = {}) => resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
export function piSessionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id.includes('..')) throw Error('Pi 会话 ID 无效');
  return id;
}

/** Owns a single Pi RPC process. Never writes to another terminal's stdin. */
export class PiClient {
  private child;
  private pending = new Map<string, { command: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: any) => void>();
  private closed = false;
  private failure?: Error;
  readonly exited: Promise<void>;
  constructor(options: PiOptions = {}, cwd?: string, args: string[] = ['--no-session', '--no-extensions', '--no-mcp']) {
    const command = piCommand(options);
    this.child = spawnProcess(command.binary, [...command.args, '--mode', 'rpc', ...args], { cwd,
      env: mergeProcessEnv(process.env, { ...buildLarkChannelEnv(options.larkChannel), PI_CODING_AGENT_DIR: piStorageDir(options) }),
      stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', () => {}); // Diagnostics can contain provider keys.
    this.child.stdin!.on('error', () => this.fail(Error('Pi 输入连接中断；未自动重发')));
    let buffer = '';
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { this.fail(Error('Pi RPC 响应过大')); void this.close(); return; }
      let index: number;
      // JSON strings may contain U+2028/U+2029: only LF is a record boundary.
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch { this.fail(Error('Pi RPC 返回无效 JSON')); void this.close(); return; }
        if (frame.type === 'response') {
          const request = this.pending.get(frame.id);
          if (!request) continue;
          this.pending.delete(frame.id); clearTimeout(request.timer);
          if (frame.command !== request.command || frame.success !== true) request.reject(Error(`Pi ${request.command} 请求被拒绝，请在 Pi 检查配置`));
          else request.resolve(frame.data);
        } else for (const listener of this.listeners) listener(frame);
      }
    });
    this.exited = new Promise(done => {
      this.child.once('error', () => { this.fail(Error('Pi 无法启动，请检查安装和可执行路径')); done(); });
      this.child.once('close', () => { this.fail(Error('Pi RPC 已退出，执行状态未确认；未自动重发')); done(); });
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  onEvent(listener: (event: any) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? Error('Pi RPC 已关闭'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Pi ${type} 请求超时；未自动重发`)); }, timeoutMs);
      this.pending.set(id, { command: type, resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ ...fields, id, type }) + '\n', error => {
        if (error) this.fail(Error('Pi RPC 写入失败；未自动重发'));
      });
    });
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.fail(Error('Pi RPC 已关闭')); this.child.kill('SIGTERM'); }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000); timer.unref();
    await this.exited; clearTimeout(timer);
  }
}
