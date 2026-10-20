import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';

export interface ZcodeOptions { binary?: string; args?: readonly string[]; dataDir?: string; modelConfigPath?: string; remoteControlFile?: string; larkChannel?: LarkChannelEnvContext }
export function zcodeStorageDir(options: Pick<ZcodeOptions, 'dataDir'> = {}): string {
  return resolve(options.dataDir ?? process.env.ZCODE_STORAGE_DIR ?? join(homedir(), '.zcode', 'cli'));
}
export function zcodeCommand(options: ZcodeOptions = {}): { binary: string; args: string[] } {
  if (options.binary) return { binary: options.binary, args: [...(options.args ?? [])] };
  if (process.env.LARK_CHANNEL_ZCODE_BIN) return { binary: process.env.LARK_CHANNEL_ZCODE_BIN, args: [...(options.args ?? [])] };
  // Linux Desktop's `zcode` is Electron, not the Agent CLI. Invoke the bundled runtime directly.
  for (const path of ['/opt/ZCode/resources/glm/zcode.cjs', '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')] : [])]) {
    if (existsSync(path)) return { binary: process.execPath, args: [path, ...(options.args ?? [])] };
  }
  return { binary: 'zcode', args: [...(options.args ?? [])] };
}
export class ZcodeRpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }

/** ZCode Protocol is NDJSON without JSON-RPC's jsonrpc field. Never resend timed-out mutations. */
export class ZcodeClient {
  private child;
  private next = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(method: string, params: any) => void>();
  readonly exited: Promise<void>;
  onInteraction?: (method: string, params: any) => void;
  constructor(options: ZcodeOptions = {}, cwd?: string) {
    const command = zcodeCommand(options);
    this.child = spawnProcess(command.binary, [...command.args, 'app-server'], { cwd,
      env: mergeProcessEnv(process.env, { ...buildLarkChannelEnv(options.larkChannel), ...(options.dataDir ? { ZCODE_STORAGE_DIR: zcodeStorageDir(options), ZCODE_DATA_BASE_DIR: zcodeStorageDir(options) } : {}) }),
      stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.child.stdout! });
    // stderr is drained, never logged: upstream diagnostics can contain credentials or full prompts.
    this.child.stderr!.on('data', () => {});
    this.child.stdin!.on('error', error => this.fail(error));
    lines.on('error', error => this.fail(error));
    lines.on('line', line => {
      if (line.length > 32 * 1024 * 1024) { this.fail(new Error('ZCode protocol frame too large')); return; }
      let value: any; try { value = JSON.parse(line); } catch { this.fail(new Error('ZCode returned invalid protocol data')); return; }
      if (typeof value.method === 'string') {
        if (value.id !== undefined) {
          if (value.method === 'session/requestRuntimePreferences') {
            this.write({ id: value.id, result: { nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } });
            return;
          }
          // Native permission/user-input requests must never be silently auto-approved.
          this.onInteraction?.(value.method, value.params);
          this.write({ id: value.id, error: { code: -32601, message: 'Bridge cannot answer this native interaction; use the ZCode client.' } });
        } else for (const listener of this.listeners) listener(value.method, value.params);
        return;
      }
      const request = this.pending.get(value.id); if (!request) return;
      this.pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new ZcodeRpcError(value.error.code, String(value.error.message)));
      else request.resolve(value.result);
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.fail(error); resolve(); });
      this.child.once('close', () => { this.fail(new Error('ZCode app-server disconnected; execution status may be unknown')); resolve(); });
    });
  }
  private write(value: unknown): void { if (!this.closed) this.child.stdin!.write(JSON.stringify(value) + '\n'); }
  onNotification(listener: (method: string, params: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ZCode connection closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ZCode ${method} timed out; not automatically retried`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('ZCode protocol write failed')); }
    });
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 1000); timer.unref();
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 5000); kill.unref();
    await this.exited; clearTimeout(timer); clearTimeout(kill);
  }
}
