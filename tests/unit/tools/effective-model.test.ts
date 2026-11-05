import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { AgentDefaultStore } from '../../../src/agent/defaults';
import { effectiveModel } from '../../../src/tools/context';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { Controls } from '../../../src/commands';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'effective-model-')); dirs.push(dir);
  const bindings = new ToolBindingStore(join(dir, 'bindings.json')); await bindings.load();
  const defaults = new AgentDefaultStore(join(dir, 'agent-defaults.json')); await defaults.load();
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true }, accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls = { profile: 'test', profileConfig, toolBindings: bindings, agentDefaults: defaults, cfg: { preferences: {} } } as unknown as Controls;
  return { dir, bindings, defaults, controls };
}

it('falls back to the console default only when the scope has no choice of its own', async () => {
  const { bindings, defaults, controls } = await setup();
  expect(effectiveModel(controls, 'codex')).toBeUndefined();
  await defaults.set('codex', 'p/console');
  expect(effectiveModel(controls, 'codex')).toBe('p/console');
  expect(effectiveModel(controls, 'kilo')).toBeUndefined();
  bindings.set('oc_a', { toolId: 'codex', sourceId: 's1' });
  expect(effectiveModel(controls, 'codex', 'oc_a')).toBe('p/console');
  bindings.set('oc_a', { toolId: 'codex', sourceId: 's1', model: 'default' });
  expect(effectiveModel(controls, 'codex', 'oc_a')).toBe('p/console');
  bindings.set('oc_a', { toolId: 'codex', sourceId: 's1', model: 'p/group' });
  expect(effectiveModel(controls, 'codex', 'oc_a')).toBe('p/group');
});

it('gives a shared group and its source group the same model every round', async () => {
  const { bindings, defaults, controls } = await setup();
  await defaults.set('codex', 'p/console');
  const source = { toolId: 'codex' as const, sourceId: 's1', nativeId: 'native' };
  bindings.set('oc_source', { ...source, name: 'AA-source' });
  bindings.set('oc_aux', { ...source, linkedSource: source, nativeCreated: true });
  bindings.linkAuxiliary('oc_shared', 'oc_aux');
  expect(effectiveModel(controls, 'codex', 'oc_source')).toBe('p/console');
  expect(effectiveModel(controls, 'codex', 'oc_shared')).toBe('p/console');
  bindings.set('oc_source', { ...source, model: 'p/group' });
  expect(effectiveModel(controls, 'codex', 'oc_source')).toBe('p/group');
  expect(effectiveModel(controls, 'codex', 'oc_shared')).toBe('p/group');
});

it('leaves a session imported from elsewhere on whatever model it already uses', async () => {
  const { bindings, defaults, controls } = await setup();
  await defaults.set('codex', 'p/console');
  const orphan = { toolId: 'codex' as const, sourceId: 's1', nativeId: 'orphan' };
  bindings.set('oc_orphan', { ...orphan, linkedSource: orphan, nativeCreated: true });
  expect(bindings.settingsScope('oc_orphan')).toBeUndefined();
  expect(effectiveModel(controls, 'codex', 'oc_orphan')).toBeUndefined();
});
