import { expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, supportedModels, normalizeModelSelection, resolveModelArg, modelLabel, loadModelChoices, normalizeReasoningEffort } from '../../../src/agent/models';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

it.each(['codex', 'claude', 'zcode'] as const)('keeps only the default locally and preserves opaque %s native model IDs', kind => {
  expect(supportedModels(kind).map(row => row.value)).toEqual([DEFAULT_MODEL]);
  expect(normalizeModelSelection(kind, undefined)).toBe(DEFAULT_MODEL);
  expect(resolveModelArg(kind, DEFAULT_MODEL)).toBeUndefined();
  expect(resolveModelArg(kind, 'vendor/new-release[1m]')).toBe('vendor/new-release[1m]');
  expect(normalizeModelSelection(kind, 'bad\nvalue')).toBe(DEFAULT_MODEL);
  expect(modelLabel(kind, 'vendor/new-release', [{ value: 'vendor/new-release', label: 'Native label' }])).toBe('Native label');
});
it('refreshes the native catalog and distinguishes deletion from discovery failure without losing the selection', async () => {
  let rows = [{ value: 'provider/a', label: 'Native A' }];
  const listModels = vi.fn(async () => rows);
  const agent = Object.assign(new FakeAgentAdapter({ id: 'zcode' }), { listModels });
  expect((await loadModelChoices(agent, '/workspace')).options.map(r => r.value)).toEqual(['default', 'provider/a']);
  rows = [{ value: 'provider/b', label: 'Native B' }];
  const removed = await loadModelChoices(agent, '/workspace', 'provider/a');
  expect(removed.available).toBe(true);
  expect(removed.options).toContainEqual({ value: 'provider/a', label: '已不可用 · provider/a', unavailable: true });
  expect(removed.options.some(r => r.value === 'provider/b')).toBe(true);
  listModels.mockRejectedValueOnce(new Error('do-not-display-private-diagnostic'));
  const failed = await loadModelChoices(agent, '/workspace', 'provider/a');
  expect(failed.available).toBe(false); expect(failed.options.at(-1)?.value).toBe('provider/a');
  expect(JSON.stringify(failed)).not.toContain('do-not-display');
  expect(listModels).toHaveBeenCalledWith({ cwd: '/workspace' });
});
it('retains engine-specific effort syntax independently of model names', () => {
  expect(normalizeReasoningEffort('claude', 'ultra')).toBe('high');
  expect(normalizeReasoningEffort('codex', 'ultra')).toBe('ultra');
});
