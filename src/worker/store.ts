import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, open, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { AgentEvent } from '../agent/types';
import type { JobSnapshot, StoredEvent, WorkerJob, WorkerSubmission } from './protocol';

export const jobIdFor = (key: string): string => createHash('sha256').update(key).digest('hex');
export function submissionFingerprint(input: WorkerSubmission): string {
  // Native IDs may appear between an initial submission and its redelivery.
  // The request key owns the original invocation; redelivery never resumes it anew.
  const o = input.options;
  const fields: unknown[] = [o.prompt, o.cwd, o.model, o.permissionMode, o.sandbox,
    o.images, o.attachmentPaths, o.delivery?.scope, o.delivery?.botAppId, o.delivery?.sourceId];
  if (o.accessMode !== undefined) fields.push({ accessMode: o.accessMode });
  // Preserve fingerprints of tasks accepted before CC effort was configurable.
  if (o.reasoningEffort !== undefined) fields.push({ reasoningEffort: o.reasoningEffort });
  return jobIdFor(JSON.stringify(fields));
}

/** Worker-only writer. Records acceptance before spawning and fsyncs every event. */
export class JobStore {
  private jobs = new Map<string, WorkerJob>();
  private events = new Map<string, StoredEvent[]>();
  constructor(readonly root: string) {}
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const job = JSON.parse(await readFile(join(this.root, name), 'utf8')) as WorkerJob;
      if (job.version !== 1 || job.id !== name.slice(0, -5) || !job.options || !job.requestKey || !job.fingerprint) throw new Error('Invalid worker job ledger');
      this.jobs.set(job.id, job);
      const path = join(this.root, `${job.id}.ndjson`);
      const bytes = await readFile(path).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
      const end = bytes.lastIndexOf(10) + 1;
      if (end < bytes.length) await truncate(path, end);
      const rows: StoredEvent[] = [];
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as StoredEvent;
        if (row.seq !== rows.length + 1 || !row.event?.type) throw new Error('Invalid worker event ledger');
        rows.push(row);
      }
      this.events.set(job.id, rows);
    }
  }
  get(id: string): WorkerJob | undefined { return this.jobs.get(id); }
  list(): WorkerJob[] { return [...this.jobs.values()]; }
  snapshot(id: string, after = 0): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? { job, events: (this.events.get(id) ?? []).filter(row => row.seq > after) } : undefined;
  }
  async put(job: WorkerJob): Promise<void> {
    await writeFileAtomic(join(this.root, `${job.id}.json`), `${JSON.stringify(job)}\n`, { mode: 0o600 });
    this.jobs.set(job.id, job);
  }
  async append(id: string, event: AgentEvent): Promise<void> {
    const rows = this.events.get(id) ?? [];
    const row: StoredEvent = { seq: rows.length + 1, at: Date.now(), event };
    const file = await open(join(this.root, `${id}.ndjson`), 'a', 0o600);
    try { await file.write(`${JSON.stringify(row)}\n`); await file.sync(); } finally { await file.close(); }
    rows.push(row); this.events.set(id, rows);
  }
}
