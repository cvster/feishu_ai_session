import { expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, supportedModels, normalizeModelSelection, resolveModelArg, modelLabel, loadModelChoices, normalizeReasoningEffort, normalizeNativeModels, reasoningOptions, resolveReasoningEffort } from '../../../src/agent/models';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

it.each(['codex', 'claude', 'zcode', 'kilo'] as const)('keeps only the default locally and preserves opaque %s native model IDs', kind => {
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
it('preserves native tokens without guessing levels from tool or model names', () => {
  expect(normalizeReasoningEffort('claude', 'native-new')).toBe('native-new');
  expect(normalizeReasoningEffort('zcode', undefined)).toBe('default');
  expect(resolveReasoningEffort('default')).toBeUndefined();
  expect(resolveReasoningEffort('bad\nvalue')).toBeUndefined();
  expect(normalizeReasoningEffort('codex', 'ultra')).toBe('ultra');
});

it('retains safe per-model metadata and resolves default capability from the native default entry', async () => {
  const metadata = { value: 'default', label: 'Native default', reasoningEfforts: [{ value: 'future', label: 'Future' }, { value: 'bad\nvalue', label: 'unsafe' }], defaultReasoningEffort: 'future', secret: 'private' };
  const agent = Object.assign(new FakeAgentAdapter(), { listModels: async () => [metadata] });
  const choices = await loadModelChoices(agent);
  expect(choices.options).toHaveLength(1);
  expect(reasoningOptions(choices.options[0]).map(option => option.value)).toEqual(['default', 'future']);
  expect(JSON.stringify(choices)).not.toContain('private');
  const fromDefault = await loadModelChoices(Object.assign(new FakeAgentAdapter(), { listModels: async () => [{ ...metadata, value: 'native-model', isDefault: true }] }));
  expect(fromDefault.options[0]?.defaultReasoningEffort).toBe('future');
  expect(normalizeNativeModels([{ value: 'no-effort', label: 'None' }])[0]?.reasoningEfforts).toBeUndefined();
});
