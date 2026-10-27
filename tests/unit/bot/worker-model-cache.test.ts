import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerModelCache, MODEL_CACHE_REFRESH_MS } from '../../../src/bot/worker-model-cache';
import { cachedModelChoices, modelCachePath } from '../../../src/agent/model-cache';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentTool } from '../../../src/tools/types';

const roots: string[] = [], stop: (() => void)[] = [];
afterEach(async () => { stop.splice(0).forEach(fn => fn()); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'worker-model-cache-')); roots.push(root); return root; }
function tool(id: string, sourceId = id) {
  const listModels = vi.fn(async ({ cwd }: { cwd?: string } = {}) => [{ value: cwd ? 'project-model' : 'global-model', label: 'Cached model' }]);
  const agent = Object.assign(new FakeAgentAdapter({ id: id as 'codex' }), { listModels });
  return { tool: { id, sourceId, label: id, agent, listSessions: async () => [] } as AgentTool, listModels };
}

it('warms all tools at startup and refreshes exactly on the 30-minute schedule, keeping settings reads offline', async () => {
  vi.useFakeTimers(); const root = await directory(), a = tool('codex'), b = tool('kilo');
  const sync = startWorkerModelCache({ profileDir: root, botAppId: 'app', tools: () => [a.tool, b.tool] }); stop.push(sync.stop);
  await sync.tick(); expect(a.listModels).toHaveBeenCalledOnce(); expect(b.listModels).toHaveBeenCalledOnce();
  const path = modelCachePath(root, 'app', 'codex', 'codex');
  expect((await cachedModelChoices(path, a.tool.agent, undefined, 'default')).options.map(row => row.value)).toEqual(['default', 'global-model']);
  await sync.tick(); expect(a.listModels).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(MODEL_CACHE_REFRESH_MS - 1); expect(a.listModels).toHaveBeenCalledOnce();
  a.listModels.mockResolvedValue([{ value: 'updated-model', label: 'Updated' }]);
  await vi.advanceTimersByTimeAsync(1); await sync.tick(); expect(a.listModels).toHaveBeenCalledTimes(2); expect(b.listModels).toHaveBeenCalledTimes(2);
  expect((await cachedModelChoices(path, a.tool.agent, undefined, 'default')).options.map(row => row.value)).toEqual(['default', 'updated-model']);
  sync.stop(); await vi.advanceTimersByTimeAsync(MODEL_CACHE_REFRESH_MS); expect(a.listModels).toHaveBeenCalledTimes(2);
});

it('preloads project catalogues once, falls back for a new project and warms late workers without refreshing existing ones', async () => {
  const root = await directory(), a = tool('claude'), b = tool('external'); let tools = [a.tool];
  const sync = startWorkerModelCache({ profileDir: root, botAppId: 'app', tools: () => tools,
    projects: current => current.id === 'claude' ? ['/project', '/project'] : [] }); stop.push(sync.stop);
  await sync.tick(); expect(a.listModels).toHaveBeenCalledTimes(2);
  const global = modelCachePath(root, 'app', 'claude', 'claude');
  const project = modelCachePath(root, 'app', 'claude', 'claude', '/project');
  expect((await cachedModelChoices(project, a.tool.agent, '/project', 'default')).options.at(-1)?.value).toBe('project-model');
  const missing = modelCachePath(root, 'app', 'claude', 'claude', '/new');
  expect((await cachedModelChoices(missing, a.tool.agent, '/new', 'default', false, { fallbackPath: global })).options.at(-1)?.value).toBe('global-model');
  tools = [a.tool, b.tool]; await sync.tick(); expect(b.listModels).toHaveBeenCalledOnce(); expect(a.listModels).toHaveBeenCalledTimes(2);
  expect(modelCachePath(root, 'app', 'claude', 'other-account')).not.toBe(global);
});

it('isolates a failing worker and keeps its last successful catalogue after periodic refresh fails', async () => {
  vi.useFakeTimers(); const root = await directory(), a = tool('codex'), b = tool('kilo');
  const sync = startWorkerModelCache({ profileDir: root, botAppId: 'app', tools: () => [a.tool, b.tool] }); stop.push(sync.stop);
  await sync.tick(); a.listModels.mockRejectedValue(Error('offline'));
  b.listModels.mockResolvedValue([{ value: 'updated', label: 'Updated' }]);
  await vi.advanceTimersByTimeAsync(MODEL_CACHE_REFRESH_MS); await sync.tick();
  const read = (t: AgentTool) => cachedModelChoices(modelCachePath(root, 'app', t.id, t.sourceId), t.agent, undefined, 'default');
  expect((await read(a.tool)).options.at(-1)?.value).toBe('global-model');
  expect((await read(b.tool)).options.at(-1)?.value).toBe('updated');
});

it('does not overlap scans or write a stale result after bridge shutdown', async () => {
  const root = await directory(), a = tool('codex'); let resolve!: (rows: { value: string; label: string }[]) => void;
  a.listModels.mockImplementation(() => new Promise(accept => { resolve = accept; }));
  const sync = startWorkerModelCache({ profileDir: root, botAppId: 'app', tools: () => [a.tool] }); stop.push(sync.stop);
  const first = sync.tick(); expect(sync.tick()).toBe(first);
  await vi.waitFor(() => expect(a.listModels).toHaveBeenCalledOnce()); sync.stop(); resolve([{ value: 'stale', label: 'Stale' }]); await first;
  expect((await cachedModelChoices(modelCachePath(root, 'app', 'codex', 'codex'), a.tool.agent, undefined, 'default')).available).toBe(false);
});
