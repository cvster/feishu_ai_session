import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions, AgentEvent } from '../../../src/agent/types';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { DurableClaudeAdapter } from '../../../src/worker/adapter';
import { JobStore, jobIdFor, submissionFingerprint } from '../../../src/worker/store';
import type { WorkerSubmission, WorkerJob } from '../../../src/worker/protocol';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { buildWorkerUnit } from '../../../src/cli/commands/worker';

import { fixture, cleanups } from '../../helpers/worker-fixture';

it('persists and forwards CC effort, rejecting a changed effort under the same request key', async () => {
  const h = await fixture();
  const options = { ...h.options, reasoningEffort: 'xhigh' as const };
  const run = h.adapter.run(options);
  const events = run.events[Symbol.asyncIterator]();
  await events.next();
  expect(h.calls[0]?.reasoningEffort).toBe('xhigh');
  expect((await h.client.snapshot(run.runId)).job.options.reasoningEffort).toBe('xhigh');
  await expect(h.client.submit({ requestKey: options.requestKey!, options: { ...options, reasoningEffort: 'low' } })).rejects.toThrow('内容已变化');
  expect(h.calls).toHaveLength(1);
  h.finish();
  while (!(await events.next()).done) { /* drain the completed task */ }
});

it('detaches bridge observers without cancelling execution, then replays the same task with one native invocation', async () => {
  const h = await fixture(); const run = h.adapter.run(h.options);
  const events = run.events[Symbol.asyncIterator](); await events.next();
  const active = new ActiveRuns(); active.register('oc_group', run); await active.disconnectAll();
  expect(h.stop).not.toHaveBeenCalled();
  expect((await h.client.snapshot(run.runId)).job.status).toBe('running');
  h.finish(); await vi.waitFor(async () => expect((await h.client.snapshot(run.runId)).job.status).toBe('completed'));
  const replay: AgentEvent[] = [];
  for await (const event of new DurableClaudeAdapter(h.client, h.raw).observe(run.runId).events) replay.push(event);
  expect(replay.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('before restart\nafter restart');
  const duplicate = await h.client.submit({ requestKey: 'message-one', options: { ...h.options, sessionId: 'native', initialSessionId: undefined } });
  expect(duplicate.id).toBe(run.runId); expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({ prompt: 'real request', cwd: h.dir, initialSessionId: 'native' });
});
it('rejects altered request content, overlapping messages, and concurrent native writers', async () => {
  const h = await fixture(); const job = await h.client.submit({ requestKey: 'message-one', options: h.options });
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await expect(h.client.submit({ requestKey: 'message-one', options: { ...h.options, prompt: 'changed' } })).rejects.toThrow('内容已变化');
  await expect(h.client.submit({ requestKey: 'different-batch', options: h.options })).rejects.toThrow('原任务接收');
  await expect(h.client.submit({ requestKey: 'new-message', options: { ...h.options, delivery: undefined } })).rejects.toThrow('已有任务');
  await h.client.stop(job.id); await vi.waitFor(async () => expect((await h.client.snapshot(job.id)).job.status).toBe('interrupted'));
  expect(h.stop).toHaveBeenCalledOnce();
});
it('does not restart accepted-but-uncertain work after a worker restart, and repairs incomplete event tails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-recovery-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'worker'), store = new JobStore(join(stateDir, 'jobs')); await store.load();
  const input: WorkerSubmission = { requestKey: 'uncertain', options: { runId: 'r', prompt: 'work', cwd: dir } };
  const job: WorkerJob = { ...input, version: 1, id: jobIdFor(input.requestKey), fingerprint: submissionFingerprint(input), status: 'accepted', createdAt: 1, updatedAt: 1 };
  await store.put(job); await store.append(job.id, { type: 'text', delta: 'saved' });
  await appendFile(join(store.root, `${job.id}.ndjson`), '{"seq":2');
  const run = vi.fn();
  const server = await startWorkerServer({ stateDir, agent: { id: 'claude', run } as unknown as AgentAdapter, sourceId: 'local', botAppId: 'cli_test' });
  cleanups.push(() => server.close());
  const client = new WorkerClient(stateDir, 'local', 'cli_test');
  const snapshot = await client.snapshot(job.id);
  expect(snapshot.job.status).toBe('unknown'); expect(snapshot.events.map(row => row.seq)).toEqual([1, 2]);
  expect(snapshot.events[0]!.event).toEqual({ type: 'text', delta: 'saved' });
  expect((await client.submit(input)).status).toBe('unknown'); expect(run).not.toHaveBeenCalled();
});
it('requires a local bearer token and verifies the configured application/source', async () => {
  const h = await fixture();
  const endpoint = JSON.parse(await readFile(join(h.stateDir, 'endpoint.json'), 'utf8'));
  expect((await fetch(`${endpoint.url}/jobs`)).status).toBe(401);
  await expect(new WorkerClient(h.stateDir, 'another-account', 'cli_test').health()).rejects.toThrow('不匹配');
  await expect(new WorkerClient(h.stateDir, 'local-claude', 'cli_test', 'codex').health()).rejects.toThrow('不匹配');
  expect(h.calls).toHaveLength(0);
});
it('defines an independent systemd unit with no bridge lifetime dependency', () => {
  const unit = buildWorkerUnit({ node: '/node', entry: '/bridge/bin/entry.mjs', profile: 'p', config: '/state/config.json', envPath: '/bin' });
  expect(unit).toContain('worker run --profile "p"');
  expect(unit).not.toMatch(/PartOf=|BindsTo=|bot\.p/);
  expect(unit).toContain('KillMode=control-group'); expect(unit).toContain('Restart=on-failure');
});

it('keeps ZCode service selection and custom storage independent of Claude', () => {
  const unit = buildWorkerUnit({ node: '/node', entry: '/bridge/entry.mjs', profile: 'p', config: '/state/config.json', envPath: '/bin',
    toolId: 'zcode', zcodeDataDir: '/private/zcode data', zcodeBinary: '/private/zcode-cli' });
  expect(unit).toContain('--tool zcode');
  expect(unit).toContain('Environment="ZCODE_STORAGE_DIR=/private/zcode data"');
  expect(unit).toContain('Environment="LARK_CHANNEL_ZCODE_BIN=/private/zcode-cli"');
  expect(unit).not.toMatch(/CLAUDE_CONFIG_DIR|LARK_CHANNEL_CLAUDE_BIN|PartOf=|BindsTo=/);
});

it('checks worker capability without restarting it or silently coercing future effort levels', async () => {
  const h = await fixture();
  expect(await h.client.health()).toMatchObject({ nativeReasoningEfforts: true });
  const health = vi.spyOn(h.client, 'health').mockResolvedValue({});
  await expect(h.adapter.prepareRun({ ...h.options, reasoningEffort: 'xhigh' })).resolves.toBeUndefined();
  await expect(h.adapter.prepareRun({ ...h.options, reasoningEffort: 'native-new' })).rejects.toThrow('worker 版本');
  expect(h.calls).toHaveLength(0); expect(h.stop).not.toHaveBeenCalled();
  health.mockResolvedValue({ nativeReasoningEfforts: true });
  await expect(h.adapter.prepareRun({ ...h.options, reasoningEffort: 'native-new' })).resolves.toBeUndefined();
});

it('requires the ZCode registry/resume fix before dispatching work to an old worker', async () => {
  const h = await fixture('zcode');
  const health = vi.spyOn(h.client, 'health').mockResolvedValue({ nativeReasoningEfforts: true });
  await expect(h.adapter.prepareRun(h.options)).rejects.toThrow('保留原会话供应商');
  expect(h.calls).toHaveLength(0); expect(h.stop).not.toHaveBeenCalled();
  health.mockResolvedValue({ nativeReasoningEfforts: true, zcodeRegistryResume: true });
  await expect(h.adapter.prepareRun(h.options)).resolves.toBeUndefined();
});
