import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolSession, ToolSessionOperations } from './types';
import { loadZcodeProviderRegistry } from '../agent/zcode/model-config';
import { zcodeWorkspace } from '../agent/zcode/adapter';
import { ZcodeClient, type ZcodeOptions } from '../agent/zcode/client';
import { writeFileAtomic } from '../platform/atomic-write';

/** Public protocol reads; transcript snapshots are references, never execution input to the source. */
export class ZcodeSessionProvider implements ToolSessionOperations {
  readonly historyMode = 'snapshot';
  private labels: Record<string, string> = {};
  private loaded = false;
  private saving = Promise.resolve();
  constructor(private options: ZcodeOptions, private stateDir: string,
    private nativeRename?: (id: string, name: string, cwd: string) => Promise<void>) {}
  private async load() {
    if (this.loaded) return;
    try { this.labels = JSON.parse(await readFile(join(this.stateDir, 'labels.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    this.loaded = true;
  }
  async listSessions(): Promise<ToolSession[]> {
    await this.load();
    const client = new ZcodeClient(this.options);
    try {
      const result = await client.request('session/list', { limit: 10000 });
      if (!Array.isArray(result.sessions)) throw new Error('ZCode 会话列表格式不兼容');
      return result.sessions.filter((s: any) => s.sessionKind === 'interactive' || s.sessionKind === 'fork').map((s: any) => ({
        nativeId: s.sessionId, name: this.options.remoteControlFile ? s.title : this.labels[s.sessionId] ?? s.title, cwd: s.workspace.workspacePath,
        createdAtMs: s.createdAt, updatedAtMs: s.updatedAt, archived: !!s.archivedAt,
      }));
    } finally { await client.close(); }
  }
  async historyPath(nativeId: string): Promise<string | undefined> {
    if (!/^(?:sess|session)_[A-Za-z0-9_-]+$/.test(nativeId)) return;
    const client = new ZcodeClient(this.options);
    try {
      // Resume loads the persisted conversation; no session/send is issued to the source.
      const snapshot = await client.request('session/resume', { sessionId: nativeId });
      if (snapshot.session?.sessionId !== nativeId || !Array.isArray(snapshot.messages)) throw new Error('ZCode 会话记录格式不兼容');
      const dir = join(this.stateDir, 'history'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${createHash('sha256').update(nativeId).digest('hex')}.json`);
      await writeFileAtomic(path, JSON.stringify({ session: snapshot.session, messages: snapshot.messages }), { mode: 0o600 });
      return path;
    } finally { await client.close(); }
  }
  async rename(nativeId: string, name: string): Promise<void> {
    if (this.options.remoteControlFile) {
      const source = (await this.listSessions()).find(row => row.nativeId === nativeId);
      if (!source?.cwd || source.archived) throw new Error('ZCode 会话不存在或已归档');
      if (!this.nativeRename) throw new Error('ZCode 原生改名执行入口尚未就绪');
      await this.nativeRename(nativeId, name, source.cwd);
      return;
    }
    await this.load(); this.labels[nativeId] = name;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const text = JSON.stringify(this.labels);
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(join(this.stateDir, 'labels.json'), text, { mode: 0o600 }));
    await this.saving;
  }
  async fork(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }> {
    if (!/^(?:sess|session)_[A-Za-z0-9_-]+$/.test(nativeId)) throw new Error('ZCode 会话 ID 无效');
    const sessions = await this.listSessions(), source = sessions.find(row => row.nativeId === nativeId);
    if (!source?.cwd || source.archived) throw new Error('ZCode 原会话不存在或已归档');
    const client = new ZcodeClient(this.options, source.cwd);
    try {
      await client.request('workspace/updateProviderRegistry', { workspace: zcodeWorkspace(source.cwd),
        registry: await loadZcodeProviderRegistry(this.options), includeWorkspaceState: false });
      const snapshot = await client.request('session/resume', { sessionId: nativeId, workspace: zcodeWorkspace(source.cwd) });
      if (snapshot.session?.sessionId !== nativeId) throw new Error('ZCode 返回了不匹配的原会话');
      if (snapshot.session?.status === 'running' || snapshot.runtime?.isRunning) throw new Error('请先停止当前 ZCode 任务，再复制会话');
      if (snapshot.restoreWarning || snapshot.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' || snapshot.runtime?.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE') throw new Error('原会话模型不可用，请先在 /config 选择模型');
      // A checkpoint fork rewinds files and fails for read-only chats. Copy at the latest message instead.
      const last = [...(snapshot.messages ?? [])].reverse().find(message => ['user', 'assistant'].includes(message.info?.role ?? message.role));
      const messageId = last?.info?.messageId ?? last?.messageId;
      if (typeof messageId !== 'string' || !messageId) throw new Error('ZCode 会话尚无可复制的对话消息');
      const result = await client.request('session/fork', { sessionId: nativeId, target: { kind: 'message', messageId } });
      const id = result.forkedSessionId;
      if (typeof id !== 'string' || !/^(?:sess|session)_[A-Za-z0-9_-]+$/.test(id) || id === nativeId || result.snapshot?.session?.sessionId !== id) throw new Error('ZCode 返回了不匹配的复制会话');
      const names = new Set(sessions.map(row => row.name)), base = source.name || 'ZCode会话';
      let n = 1; while (names.has(`${base} (${n})`)) n++;
      const name = `${base} (${n})`;
      await this.rename(id, name);
      return { nativeId: id, name, cwd: source.cwd };
    } finally { await client.close(); }
  }
  async archive(_nativeId: string): Promise<void> { /* Bridge catalog owns archival; original native history stays intact. */ }
}
