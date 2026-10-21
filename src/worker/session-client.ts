import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolSession, ToolSessionOperations } from '../tools/types';
import { writeFileAtomic } from '../platform/atomic-write';
import { WorkerClient, WorkerRequestError } from './client';
import type { WorkerCapabilities } from './protocol';

/** Choose the v1 fallback before the operation; never replay a failed mutation. */
export class WorkerSessionClient implements ToolSessionOperations {
  readonly historyMode;
  readonly nativeArchive;
  readonly fork?: ToolSessionOperations['fork'];
  constructor(private client: WorkerClient, private legacyList: () => Promise<ToolSession[]>,
    private legacy: ToolSessionOperations, private cacheDir: string, private validateMutation?: () => Promise<void>) {
    this.historyMode = legacy.historyMode;
    this.nativeArchive = legacy.nativeArchive;
    if (legacy.fork) this.fork = id => this.forkSession(id);
  }
  private async useWorker(operation: keyof WorkerCapabilities['sessions']): Promise<boolean> {
    const capabilities = await this.client.capabilities();
    if (!capabilities) return false;
    if (!capabilities.sessions[operation]) throw new WorkerRequestError(501, `Worker does not support session ${operation}`, false, 'unsupported-operation');
    return true;
  }
  async listSessions(): Promise<ToolSession[]> {
    return await this.useWorker('list') ? this.client.listSessions() : this.legacyList();
  }
  async historyPath(id: string): Promise<string | undefined> {
    if (!await this.useWorker('history')) return this.legacy.historyPath(id);
    let history;
    try { history = await this.client.sessionHistory(id); }
    catch (error) { if (error instanceof WorkerRequestError && error.status === 404) return; throw error; }
    const expectedFormat = this.historyMode === 'snapshot' ? 'json' : 'jsonl';
    if (history.nativeId !== id || history.format !== expectedFormat || typeof history.content !== 'string' ||
      Buffer.byteLength(history.content) > 32 * 1024 * 1024) throw new Error('Worker returned incompatible session history');
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = join(this.cacheDir, `${createHash('sha256').update(id).digest('hex')}.${history.format === 'json' ? 'json' : 'jsonl'}`);
    await writeFileAtomic(path, history.content, { mode: 0o600 }); return path;
  }
  async rename(id: string, name: string): Promise<void> {
    if (await this.useWorker('rename')) { await this.validateMutation?.(); await this.client.renameSession(id, name); }
    else await this.legacy.rename(id, name);
  }
  async archive(id: string): Promise<void> {
    // Preserve catalog-only archival: the worker must not claim it archived
    // native data, and the bridge still owns its local archive ledger.
    if (this.nativeArchive === false) { await this.legacy.archive(id); return; }
    if (await this.useWorker('archive')) { await this.validateMutation?.(); await this.client.archiveSession(id); }
    else await this.legacy.archive(id);
  }
  private async forkSession(id: string) {
    if (!await this.useWorker('fork')) return this.legacy.fork!(id);
    await this.validateMutation?.(); return this.client.forkSession(id);
  }
}
