import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type SessionState = 'pending' | 'active' | 'archived' | 'missing' | 'unsupported';
export type GroupState = 'active' | 'dissolved';
export interface ConfirmedState { state: SessionState | GroupState; checkedAt: number }
export interface StateInspection { result: 'ok' | 'offline' | 'failed' | 'unchecked'; attemptedAt: number; checkedAt?: number; reason?: string }

/** Stores evidence, never an inference from an offline worker or a failed read. */
export class ManagementStateStore {
  private records: Record<string, ConfirmedState> = {};
  private loading?: Promise<void>;
  constructor(private path?: string) {}
  load(): Promise<void> {
    return this.loading ??= (async () => {
      if (!this.path) return;
      try {
        const data = JSON.parse(await readFile(this.path, 'utf8'));
        if (data.version !== 1 || !data.records || Array.isArray(data.records)) throw Error('AI群检查状态账本无效');
        for (const [key, value] of Object.entries(data.records)) {
          const r = value as ConfirmedState;
          if (!/^[a-f0-9]{64}$/.test(key) || !['pending', 'active', 'archived', 'missing', 'unsupported', 'dissolved'].includes(r.state) ||
            !Number.isFinite(r.checkedAt) || r.checkedAt < 0) throw Error('AI群检查状态记录无效');
        }
        this.records = data.records;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  }
  get(key: string): ConfirmedState | undefined { return this.records[key]; }
  confirm(key: string, state: ConfirmedState['state'], checkedAt = Date.now()): ConfirmedState {
    return this.records[key] = { state, checkedAt };
  }
  async save(keys: Set<string>): Promise<void> {
    for (const key of Object.keys(this.records)) if (!keys.has(key)) delete this.records[key];
    if (this.path) await writeFileAtomic(this.path, JSON.stringify({ version: 1, records: this.records }) + '\n', { mode: 0o600 });
  }
}
