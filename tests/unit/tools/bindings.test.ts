import { controlsForTool } from '../../../src/tools/context';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolBindingStore, sessionRefKey } from '../../../src/tools/bindings';
import { NativeSessionLocks } from '../../../src/tools/locks';
import { SessionCatalog } from '../../../src/session/catalog';
const clean: string[] = [];
afterEach(async () => { await Promise.all(clean.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('persists immutable group choices and separates archives by tool and source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tools-bindings-')); clean.push(root);
  const path = join(root, 'bindings.json'); const store = new ToolBindingStore(path);
  await store.load(); store.set('oc_c', { toolId: 'claude', sourceId: 'local', nativeId: 'same-id' });
  store.set('oc_g', { toolId: 'codex', sourceId: 'local', nativeId: 'same-id' });
  store.archive('claude', 'local', 'same-id'); await store.flush();
  const restored = new ToolBindingStore(path); await restored.load();
  expect(restored.get('oc_c:topic')?.toolId).toBe('claude');
  expect(restored.isArchived('claude', 'local', 'same-id')).toBe(true);
  expect(restored.isArchived('codex', 'local', 'same-id')).toBe(false);
  expect(restored.isArchived('claude', 'another-account', 'same-id')).toBe(false);
  expect(() => restored.set('oc_c', { toolId: 'codex', sourceId: 'local' })).toThrow('不能切换');
  expect(() => restored.set('oc_c:topic', { toolId: 'codex', sourceId: 'local' })).toThrow('不能切换');
});
it('migrates existing Codex bindings without changing their native ID on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tools-migration-')); clean.push(root);
  const catalog = new SessionCatalog(join(root, 'catalog.json')); await catalog.load();
  catalog.upsertActive({ scopeId: 'old-group', agentId: 'codex', cwdRealpath: root, policyFingerprint: 'legacy', threadId: 'old-native' });
  await catalog.flush();
  const path = join(root, 'bindings.json'); const store = new ToolBindingStore(path); await store.load();
  store.migrate(catalog, () => 'original-home'); await store.flush();
  const restored = new ToolBindingStore(path); await restored.load();
  restored.migrate(catalog, () => 'changed-home');
  expect(restored.get('old-group')).toMatchObject({ toolId: 'codex', sourceId: 'original-home', nativeId: 'old-native' });
});
it('rejects conflicting legacy tools for a group rather than silently routing to the latest row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tools-conflict-')); clean.push(root);
  const catalog = new SessionCatalog(join(root, 'catalog.json')); await catalog.load();
  catalog.upsertActive({ scopeId: 'group', agentId: 'codex', cwdRealpath: root, policyFingerprint: 'c', threadId: 'native' });
  catalog.upsertActive({ scopeId: 'group', agentId: 'claude', cwdRealpath: root, policyFingerprint: 'a', sessionId: 'native' });
  await catalog.flush();
  // Reconstruct the pre-migration array, where both revisions claimed to be active.
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog.entries().map(row => ({ ...row, status: 'active' }))));
  await expect(new SessionCatalog(join(root, 'catalog.json')).load()).rejects.toThrow('工具身份冲突');
});
it('fails closed on malformed persisted state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tools-invalid-')); clean.push(root);
  const path = join(root, 'ledger.json'); await writeFile(path, '{"version":1,"bindings":{"chat":{"toolId":"unknown"}},"archived":[]}');
  await expect(new ToolBindingStore(path).load()).rejects.toThrow('Invalid');
});
it('locks a native session across group executors while keeping different tools independent', () => {
  const locks = new NativeSessionLocks(); const key = sessionRefKey('claude', 'local', 'id');
  const release = locks.acquire(key)!; expect(locks.acquire(key)).toBeUndefined();
  expect(locks.acquire(sessionRefKey('codex', 'local', 'id'))).toBeTypeOf('function');
  release(); expect(locks.acquire(key)).toBeTypeOf('function');
});

it('persists shared auxiliary aliases and propagates native creation without merging unrelated sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tools-shared-')); clean.push(root);
  const path = join(root, 'bindings.json'); const store = new ToolBindingStore(path); await store.load();
  const linkedSource = { toolId: 'codex' as const, sourceId: 'home', nativeId: 'original', historyPath: 'history' };
  store.set('aux_canonical', { toolId: 'codex', sourceId: 'home', name: 'FF-original', linkedSource, nativeCreated: false });
  store.linkAuxiliary('oc_a', 'aux_canonical'); store.linkAuxiliary('oc_b', 'aux_canonical');
  store.set('oc_a', { ...store.get('oc_a')!, nativeId: 'shared-native', nativeCreated: true }); await store.flush();
  const restored = new ToolBindingStore(path); await restored.load();
  expect(restored.get('oc_b')).toMatchObject({ nativeId: 'shared-native', nativeCreated: true, sharedScope: 'aux_canonical' });
  expect(restored.hasNativeBinding('codex', 'home', 'shared-native', new Set(['oc_b']))).toBe(true);
  store.set('personal', { toolId: 'codex', sourceId: 'home', nativeId: 'personal' });
  expect(() => store.linkAuxiliary('personal', 'aux_canonical')).toThrow('不能覆盖');
  expect(() => store.linkAuxiliary('oc_c', 'missing')).toThrow('Invalid');
  await store.flush();
});

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('shared %s entries follow original model settings live and clear old overrides', async toolId => {
  const root = await mkdtemp(join(tmpdir(), 'shared-model-')); clean.push(root);
  const store = new ToolBindingStore(join(root, 'bindings')); await store.load();
  store.set('oc_original', { toolId, sourceId: root, nativeId: 'original', model: 'model-v1', reasoningEffort: 'high' });
  store.set('aux_shared', { toolId, sourceId: root, nativeId: 'original', model: 'stale-model', reasoningEffort: 'stale-effort',
    linkedSource: { toolId, sourceId: root, nativeId: 'original' } });
  store.linkAuxiliary('oc_open', 'aux_shared'); store.linkAuxiliary('a2a_task', 'aux_shared');
  store.set('oc_ffowner', { toolId, sourceId: root, nativeId: 'original', auxiliaryWorkgroup: true, model: 'stale-owner' });
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'fake' },
    preferences: { model: 'global-default', reasoningEffort: 'medium' }, accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } } });
  const controls = { profileConfig, toolBindings: store } as any;
  const views = ['oc_open', 'a2a_task', 'oc_ffowner'].map(scope => controlsForTool(controls, toolId, scope));
  expect(views.map(view => view.profileConfig.preferences.model)).toEqual(Array(3).fill('model-v1'));
  store.set('oc_original', { ...store.get('oc_original')!, model: 'model-v2', reasoningEffort: 'low' });
  for (const view of views) expect(view.profileConfig.preferences).toMatchObject({ model: 'model-v2', reasoningEffort: 'low' });
  expect(store.settingsScope('oc_ffowner')).toBe('oc_original');
  store.set('oc_original', { ...store.get('oc_original')!, model: 'default', reasoningEffort: undefined });
  for (const view of views) { expect(view.profileConfig.preferences.model).toBeUndefined(); expect(view.profileConfig.preferences.reasoningEffort).toBeUndefined(); }
  await store.flush();
});
it('does not guess model ownership when the original workgroup is absent or ambiguous', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-model-owner-')); clean.push(root);
  const store = new ToolBindingStore(join(root, 'bindings')); await store.load();
  store.set('aux_shared', { toolId: 'codex', sourceId: root, nativeId: 'original', linkedSource: { toolId: 'codex', sourceId: root, nativeId: 'original' } });
  store.linkAuxiliary('oc_open', 'aux_shared'); expect(store.settingsScope('oc_open')).toBeUndefined();
  await store.flush();
  await writeFile(join(root, 'bindings'), JSON.stringify({ version: 1, archived: [], bindings: {
    ...Object.fromEntries(store.entries()), oc_a: { toolId: 'codex', sourceId: root, nativeId: 'original' },
    oc_b: { toolId: 'codex', sourceId: root, nativeId: 'original' },
  } }));
  await store.load(); // Pre-upgrade ambiguity remains readable until startup reconciliation.
  expect(store.settingsScope('oc_open')).toBeUndefined(); await store.flush();
});
