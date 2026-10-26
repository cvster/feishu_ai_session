import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JOB_RETENTION_MS, JobStore, jobIdFor } from '../../../src/worker/store';
import type { JobStatus, WorkerJob } from '../../../src/worker/protocol';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const job = (key: string, status: JobStatus, updatedAt: number): WorkerJob => ({ requestKey: key, options: { runId: key, prompt: 'p', cwd: '/' },
  version: 1, id: jobIdFor(key), fingerprint: 'f', status, createdAt: updatedAt, updatedAt });

it('prunes finished jobs and their event logs after the retention window, never active ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-retention-')); dirs.push(root);
  let now = 1_000;
  const store = new JobStore(root, () => now); await store.load();
  for (const item of [job('old-done', 'completed', now), job('old-running', 'running', now), job('old-unknown', 'unknown', now)]) {
    await store.put(item); await store.append(item.id, { type: 'text', delta: 'x' });
  }
  now += JOB_RETENTION_MS;
  await store.put(job('fresh', 'failed', now));
  const restarted = new JobStore(root, () => now); await restarted.load();
  expect(restarted.list().map(j => j.requestKey).sort()).toEqual(['fresh', 'old-running']);
  expect((await readdir(root)).sort()).toEqual([`${jobIdFor('fresh')}.json`, `${jobIdFor('old-running')}.json`, `${jobIdFor('old-running')}.ndjson`].sort());
  expect(restarted.snapshot(jobIdFor('old-running'))?.events).toHaveLength(1);
});
