import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachedModelChoices } from '../../../src/agent/model-cache';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('never discovers implicitly, persists refresh results and retains them after a failed refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'models-cache-')); roots.push(root);
  const path = join(root, 'cache.json'), listModels = vi.fn(async () => [{ value: 'provider/model', label: 'Model' }]);
  const agent = Object.assign(new FakeAgentAdapter(), { listModels });
  const initial = await cachedModelChoices(path, agent, '/project', 'saved-model');
  expect(initial.options.map(row => row.value)).toEqual(['default', 'saved-model']);
  expect(listModels).not.toHaveBeenCalled();
  expect((await cachedModelChoices(path, agent, '/project', 'default', true)).options.map(row => row.value)).toEqual(['default', 'provider/model']);
  listModels.mockClear(); listModels.mockRejectedValue(Error('private-error'));
  expect((await cachedModelChoices(path, agent, '/project', 'default')).options.map(row => row.value)).toEqual(['default', 'provider/model']);
  expect(listModels).not.toHaveBeenCalled();
  const failed = await cachedModelChoices(path, agent, '/project', 'default', true);
  expect(failed.options.map(row => row.value)).toEqual(['default', 'provider/model']);
  expect(failed.notice).toContain('保留缓存'); expect(failed.notice).not.toContain('private-error');
});
