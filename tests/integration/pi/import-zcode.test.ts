import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importZcodeToPi, piProviderIds, renamePiModel, renamePiSettings } from '../../../src/agent/pi/import-zcode';
import { PiNativeConversationReader } from '../../../src/agent/pi/conversation';
import { runPiImport } from '../../../src/cli/commands/pi';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, loadRootConfig } from '../../../src/config/profile-store';
import { ToolBindingStore } from '../../../src/tools/bindings';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('imports Zcode names as native Pi IDs and migrates defaults and existing sessions without rewriting history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-names-')); roots.push(root);
  const agentDir = join(root, 'agent'), dir = join(agentDir, 'sessions', '--project--'); await mkdir(dir, { recursive: true });
  const zcode = join(root, 'zcode.json');
  const source = { provider: { 'new-provider': { name: 'gaoliu', kind: 'openai-compatible', options: { baseURL: 'https://example.invalid/v1', apiKey: 'fixture-secret' }, models: { 'model/one': { name: 'One' } } } }, model: 'new-provider/model/one' };
  const sourceText = JSON.stringify(source); await writeFile(zcode, sourceText, { mode: 0o600 });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'new-provider': { name: 'gaoliu', baseUrl: 'https://example.invalid/v1' }, other: { name: 'Keep other' } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'new-provider', defaultModel: 'model/one', enabledModels: ['new-provider/*', 'other/keep'], modelThinkingLevels: { 'new-provider/model/one': 'high' }, lastChangelogVersion: '1.4.0' }));
  const header = { type: 'session', version: 3, id: 'native-session', cwd: root, timestamp: '2026-10-29T00:00:00.000Z' };
  const old = [header,
    { type: 'model_change', id: 'model', parentId: null, provider: 'new-provider', modelId: 'model/one' },
    { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: 'keep new-provider in prompt' } },
    { type: 'message', id: 'assistant', parentId: 'user', message: { role: 'assistant', provider: 'new-provider', model: 'model/one', content: [{ type: 'text', text: 'keep new-provider in answer' }], stopReason: 'stop' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  const path = join(dir, 'native-session.jsonl'); await writeFile(path, old, { mode: 0o600 });
  const result = await importZcodeToPi({ modelConfigPath: zcode }, { agentDir });
  expect(result).toMatchObject({ providers: 1, models: 1, providerIds: { 'new-provider': 'gaoliu' }, migratedSessions: 1 });
  const config = JSON.parse(await readFile(result.path, 'utf8'));
  expect(Object.keys(config.providers).sort()).toEqual(['gaoliu', 'other']);
  expect(config.providers.gaoliu).toMatchObject({ name: 'gaoliu', apiKey: 'fixture-secret' });
  expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toMatchObject({ defaultProvider: 'gaoliu', defaultModel: 'model/one', enabledModels: ['gaoliu/*', 'other/keep'], modelThinkingLevels: { 'gaoliu/model/one': 'high' }, lastChangelogVersion: '1.4.0' });
  const migrated = await readFile(path, 'utf8'); expect(migrated.startsWith(old)).toBe(true);
  const appended = migrated.slice(old.length).trim().split('\n').map(e => JSON.parse(e));
  expect(appended).toMatchObject([{ type: 'model_change', parentId: 'assistant', provider: 'gaoliu', modelId: 'model/one' }]);
  const snapshot = await new PiNativeConversationReader({ agentDir }).read(header.id);
  expect(snapshot.settings?.model).toBe('gaoliu/model/one'); expect(snapshot.turns).toHaveLength(1);
  expect(await readFile(zcode, 'utf8')).toBe(sourceText);
  expect((await importZcodeToPi({ modelConfigPath: zcode }, { agentDir })).migratedSessions).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(migrated);
});

it('rejects collisions and falls back for names that cannot form provider/model selections', () => {
  const registry = (providers: any[]) => ({ revision: 'fixture', generatedAt: 0, providers }) as any;
  expect(piProviderIds(registry([{ providerId: 'a', label: 'same' }, { providerId: 'b', label: 'same' }]))).toEqual({ a: 'a', b: 'b' });
  expect(piProviderIds(registry([{ providerId: 'a', label: 'a/b' }, { providerId: 'b', label: 'tars-dev' }]))).toEqual({ a: 'a', b: 'tars-dev' });
  expect(() => piProviderIds(registry([{ providerId: 'a', label: 'b' }, { providerId: 'b', label: 'c' }]))).toThrow('冲突');
  expect(renamePiModel('a/model/one', { a: 'gaoliu' })).toBe('gaoliu/model/one');
  expect(renamePiModel('default', { a: 'gaoliu' })).toBe('default');
  expect(renamePiSettings({ defaultProvider: 'a', setting: 'a/model' }, { a: 'gaoliu' })).toEqual({ defaultProvider: 'gaoliu', setting: 'a/model' });
});

it('updates saved Pi model selections in bridge bindings and primary preferences while retaining other tools and shared aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-cli-')); roots.push(root);
  const agentDir = join(root, 'agent'), config = join(root, 'config.json'), zcode = join(root, 'zcode.json');
  // Even a regression in profile persistence must never write the user's directory.
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'fallback-agent'));
  await writeFile(zcode, JSON.stringify({ provider: { 'new-provider': { name: 'tars-dev', kind: 'openai-compatible', options: { baseURL: 'https://example.invalid/v1', apiKey: 'fixture' }, models: { m: {} } } }, model: 'new-provider/m' }));
  const profile = createDefaultProfileConfig({ agentKind: 'pi', accounts: { app: { id: 'app', secret: 'fixture', tenant: 'feishu' } },
    preferences: { model: 'new-provider/m' }, pi: { binaryPath: 'pi', agentDir }, zcode: { binaryPath: 'zcode', modelConfigPath: zcode } });
  await saveRootConfig(createRootConfig('test', profile), config);
  expect((await loadRootConfig(config))?.profiles.test?.pi?.agentDir).toBe(agentDir);
  const path = join(root, 'profiles', 'test', 'tool-bindings.json'), bindings = new ToolBindingStore(path);
  await bindings.load();
  const source = { toolId: 'pi', sourceId: agentDir, nativeId: 'native' };
  bindings.set('oc_pi', { ...source, model: 'new-provider/m' });
  bindings.set('aux_pi', { ...source, model: 'new-provider/m', linkedSource: source });
  bindings.linkAuxiliary('oc_shared', 'aux_pi');
  bindings.set('oc_codex', { toolId: 'codex', sourceId: '/other', nativeId: 'other', model: 'new-provider/m' });
  await bindings.flush();
  await runPiImport({ config, profile: 'test' });
  const restored = new ToolBindingStore(path); await restored.load();
  expect(restored.get('oc_pi')?.model).toBe('tars-dev/m');
  expect(restored.get('oc_shared')).toMatchObject({ sharedScope: 'aux_pi', model: 'tars-dev/m' });
  expect(restored.get('oc_codex')?.model).toBe('new-provider/m');
  expect((await loadRootConfig(config))?.profiles.test?.preferences.model).toBe('tars-dev/m');
});
