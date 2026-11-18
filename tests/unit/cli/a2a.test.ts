import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { saveRootConfig } from '../../../src/config/profile-store';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { runA2A } from '../../../src/cli/commands/a2a';
import { a2aSessionBindings } from '../../../src/a2a/sessions';
import { authenticate, DEFAULT_A2A_PORT, defaultAlias, loadA2AConfig, mintKey, saveA2AConfig, type A2AConfig } from '../../../src/a2a/config';

const roots: string[] = [];
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), networkInterfaces: () => ({
  ethernet: [{ family: 'IPv4', address: '10.88.1.2', internal: false }], wifi: [{ family: 'IPv4', address: '192.168.1.2', internal: false }],
}) }));
vi.mock('@larksuite/channel', () => ({ createLarkChannel: () => ({ getAppInfo: async () => ({ ownerId: 'ou_current_owner' }) }) }));
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

it('configures only the local 10.88 interface and default port, issues owner-bound keys, and persists dual aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-cli-')); roots.push(root);
  const profileDir = join(root, 'profiles', 'test'), configPath = join(root, 'config.json');
  const selected = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app: { id: 'cli_test', secret: 'fake', tenant: 'feishu' } } });
  await saveRootConfig({ schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: selected } }, configPath);
  const shared = 'aux_11111111-1111-4111-8111-111111111111';
  const bindings = new ToolBindingStore(join(profileDir, 'tool-bindings.json')); await bindings.load();
  bindings.set(shared, { toolId: 'codex', sourceId: root, name: 'AA-project', nativeId: 'original', nativeCreated: true, linkedSource: { toolId: 'codex', sourceId: root, nativeId: 'original', historyPath: '/history' } }); await bindings.flush();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {}), options = { config: configPath, profile: 'test' };
  await runA2A('configure', undefined, { ...options, namespace: 'TestUser' });
  expect(await loadA2AConfig(join(profileDir, 'a2a.json'))).toMatchObject({ namespace: 'TestUser', host: '10.88.1.2', port: DEFAULT_A2A_PORT, enabled: true });
  await expect(runA2A('configure', undefined, { ...options, host: '0.0.0.0' })).rejects.toThrow('10.88');
  await expect(runA2A('configure', undefined, { ...options, host: '192.168.1.2' })).rejects.toThrow('10.88');
  await expect(runA2A('configure', undefined, { ...options, namespace: 'AnotherUser' })).rejects.toThrow('已固定');
  await runA2A('enable', defaultAlias(shared), { ...options, alias: 'project' });
  await runA2A('grant', 'project', { ...options, name: 'colleague' });
  const issued = JSON.parse(output.mock.calls.at(-1)![0]);
  expect(issued).toMatchObject({ alias: 'project', enabled: true, role: 'member' });
  const saved = await loadA2AConfig(join(profileDir, 'a2a.json'));
  expect(authenticate(saved!.endpoints[shared]!, `Bearer ${issued.token}`, 'ou_current_owner')?.name).toBe('colleague');
  expect(authenticate(saved!.endpoints[shared]!, `Bearer ${issued.token}`, 'ou_other_owner')).toBeUndefined();
  expect(await readFile(join(profileDir, 'a2a.json'), 'utf8')).not.toContain(issued.token);
  output.mockClear(); await runA2A('list', undefined, options);
  expect(output.mock.calls.map(c => c[0]).join('')).not.toContain(issued.token);
  await runA2A('revoke', 'project', { ...options, keyId: issued.keyId });
  const revoked = await loadA2AConfig(join(profileDir, 'a2a.json'));
  expect(authenticate(revoked!.endpoints[shared]!, `Bearer ${issued.token}`, 'ou_current_owner')).toBeUndefined();
});

it('fails closed on invalid keys, ambiguous aliases, wildcard listeners and malformed registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-config-')); roots.push(root);
  const path = join(root, 'a2a.json'), issued = mintKey('test', 'owner');
  const config: A2AConfig = { version: 1, enabled: true, host: '10.88.1.2', namespace: 'TestUser', port: DEFAULT_A2A_PORT,
    endpoints: { aux_a: { enabled: true, alias: 'project', keys: [issued.key] } } };
  expect(authenticate(config.endpoints.aux_a!, 'Bearer invalid', 'owner')).toBeUndefined();
  expect(authenticate(config.endpoints.aux_a!, undefined, 'owner')).toBeUndefined();
  await saveA2AConfig(path, { ...config, host: '0.0.0.0' }); await expect(loadA2AConfig(path)).rejects.toThrow();
  config.endpoints.aux_b = { enabled: true, alias: 'project', keys: [] };
  await saveA2AConfig(path, config); await expect(loadA2AConfig(path)).rejects.toThrow('aliases');
});

it('enables a personal AA session without writing its live binding ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-personal-')); roots.push(root);
  const profileDir = join(root, 'profiles', 'test'), configPath = join(root, 'config.json');
  const selected = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app: { id: 'cli_test', secret: 'fake', tenant: 'feishu' } } });
  await saveRootConfig({ schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: selected } }, configPath);
  const path = join(profileDir, 'tool-bindings.json'), bindings = new ToolBindingStore(path); await bindings.load();
  bindings.set('oc_personal', { toolId: 'codex', sourceId: root, name: 'AA-a1地图', nativeId: 'original', nativeCreated: true }); await bindings.flush();
  const before = await readFile(path, 'utf8'), output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const options = { config: configPath, profile: 'test' };
  await runA2A('configure', undefined, { ...options, namespace: 'TestUser' });
  await runA2A('list', undefined, options);
  const entry = JSON.parse(output.mock.calls.at(-1)![0]);
  expect(entry).toMatchObject({ name: 'AA-a1地图', enabled: false });
  await runA2A('enable', entry.defaultAlias, { ...options, alias: 'a1-map' });
  await runA2A('grant', 'a1-map', { ...options, name: 'map-agent' });
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ alias: 'a1-map', role: 'member', enabled: true });
  expect(await readFile(path, 'utf8')).toBe(before);
  const routes = a2aSessionBindings(bindings.entries());
  expect(routes[0]![0]).toBe(entry.id);
  bindings.set(entry.id, routes[0]![1]);
  expect(a2aSessionBindings(bindings.entries())).toHaveLength(1);
});
