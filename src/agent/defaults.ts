import { readFile, rename } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

/** Settings only accept tokens a CLI can take as `--model`; never free text or flags. */
export function isStorableModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !value.startsWith('-') && !/[\x00-\x1f]/.test(value);
}

/**
 * Bridge-owned default model per tool. It is a plain preference: the run flow
 * uses it whenever a scope has no explicit choice of its own.
 */
export class AgentDefaultStore {
  /** Null prototype: a repo-controlled key such as `__proto__` stays a plain entry. */
  private models: Record<string, string> = Object.create(null);
  /** Entries that failed validation are kept verbatim so a save never deletes them. */
  private other: Record<string, unknown> = Object.create(null);
  private queue: Promise<unknown> = Promise.resolve();
  private broken?: string;

  constructor(private readonly path: string) {}

  /** A missing file is normal; anything we cannot trust puts the store in read-only mode. */
  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.broken = '默认模型配置无法读取';
      log.warn('models', 'defaults-unreadable', { path: this.path });
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch {
      const corrupt = `${this.path}.corrupt-${Date.now()}`;
      try { await rename(this.path, corrupt); }
      catch { this.broken = '默认模型配置已损坏且无法隔离'; log.fail('models', new Error('defaults-isolate-failed'), { path: this.path, corrupt }); return; }
      log.warn('models', 'defaults-corrupt', { path: this.path, corrupt });
      return;
    }
    const rows = (raw as { version?: unknown; models?: unknown } | null)?.models;
    if ((raw as { version?: unknown } | null)?.version !== 1 || !rows || typeof rows !== 'object' || Array.isArray(rows)) {
      this.broken = '默认模型配置版本不受支持';
      log.warn('models', 'defaults-unsupported', { path: this.path });
      return;
    }
    const models: Record<string, string> = Object.create(null), other: Record<string, unknown> = Object.create(null);
    for (const [tool, value] of Object.entries(rows as Record<string, unknown>)) {
      if (isStorableModel(value)) models[tool] = value; else other[tool] = value;
    }
    this.models = models;
    this.other = other;
  }

  get brokenReason(): string | undefined { return this.broken; }

  get(toolId: string): string | undefined {
    return Object.hasOwn(this.models, toolId) ? this.models[toolId] : undefined;
  }

  /** Disk first: a failed write must never change what the next run uses. */
  set(toolId: string, value: string | undefined): Promise<void> {
    // A failed write rejects this call only; the queue keeps accepting later writes.
    const run = this.queue.then(() => this.persist(toolId, value));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(toolId: string, value: string | undefined): Promise<void> {
    if (this.broken) throw new Error(this.broken);
    const models: Record<string, string> = Object.assign(Object.create(null), this.models);
    if (value === undefined) delete models[toolId]; else models[toolId] = value;
    const merged: Record<string, unknown> = { ...this.other, ...models };
    await writeFileAtomic(this.path, JSON.stringify({ version: 1, models: merged }, null, 2) + '\n', { mode: 0o600 });
    this.models = models;
  }
}
