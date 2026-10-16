import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolSession, ToolSessionOperations } from './types';
import { ZcodeClient, type ZcodeOptions } from '../agent/zcode/client';
import { writeFileAtomic } from '../platform/atomic-write';

/** Public protocol reads; transcript snapshots are references, never execution input to the source. */
export class ZcodeSessionProvider implements ToolSessionOperations {
  readonly historyMode = 'snapshot';
  private labels: Record<string, string> = {};
  private loaded = false;
  private saving = Promise.resolve();
  constructor(private options: ZcodeOptions, private stateDir: string) {}
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
        nativeId: s.sessionId, name: this.labels[s.sessionId] ?? s.title, cwd: s.workspace.workspacePath,
        createdAtMs: s.createdAt, updatedAtMs: s.updatedAt, archived: !!s.archivedAt,
      }));
    } finally { await client.close(); }
  }
  async historyPath(nativeId: string): Promise<string | undefined> {
    if (!/^sess_[A-Za-z0-9_-]+$/.test(nativeId)) return;
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
    await this.load(); this.labels[nativeId] = name;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const text = JSON.stringify(this.labels);
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(join(this.stateDir, 'labels.json'), text, { mode: 0o600 }));
    await this.saving;
  }
  async archive(_nativeId: string): Promise<void> { /* Bridge catalog owns archival; original native history stays intact. */ }
}
