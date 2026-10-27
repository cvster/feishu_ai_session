import { readFile } from 'node:fs/promises';
import { webSecretHash } from './config';
import { writeFileAtomic } from '../platform/atomic-write';

interface LoginSession { owner: string; hash: string; expires: number }

/** Persist only token digests, so bridge restarts preserve unexpired browser logins. */
export class WebLoginSessions {
  private records = new Map<string, LoginSession>();
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error('网页登录状态文件无效');
      for (const row of data.sessions.slice(-64)) {
        if (row && /^[a-f0-9]{64}$/.test(row.tokenHash) && /^[a-f0-9]{64}$/.test(row.hash) &&
          typeof row.owner === 'string' && Number.isSafeInteger(row.expires) && row.expires > Date.now()) {
          this.records.set(row.tokenHash, { owner: row.owner, hash: row.hash, expires: row.expires });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  get(token: string) { return this.records.get(webSecretHash(token)); }
  async set(token: string, session: LoginSession) {
    await this.mutate(() => {
      for (const [key, row] of this.records) if (row.expires <= Date.now()) this.records.delete(key);
      if (this.records.size >= 64) this.records.delete(this.records.keys().next().value!);
      this.records.set(webSecretHash(token), session);
    });
  }
  async delete(token: string) { await this.mutate(() => { this.records.delete(webSecretHash(token)); }); }
  private mutate(change: () => void) {
    const result = this.writing.then(async () => {
      const previous = new Map(this.records);
      change();
      try {
        await writeFileAtomic(this.path, JSON.stringify({ version: 1,
          sessions: [...this.records].map(([tokenHash, row]) => ({ tokenHash, ...row })) }) + '\n', { mode: 0o600 });
      } catch (error) { this.records = previous; throw error; }
    });
    this.writing = result.catch(() => {});
    return result;
  }
}
