import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { discoverWorkers, loadWorkerRegistry, workerTool } from '../../../src/worker/discovery';
import { startWorkerServer } from '../../../src/worker/server';
import { migrateWorkerConfiguration, migrateLegacyIntake } from '../../../src/worker/migration';
import { migrateMirrorLedger } from '../../../src/worker/mirror-migration';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { WorkerInbox } from '../../../src/worker/inbox';
import { SessionCatalog } from '../../../src/session/catalog';
import { loadWorkerConfig } from '../../../src/worker/config';
import { type AgentAdapter } from '../../../src/agent/types';
import { nativeSessionFields } from '../../../src/tools/definitions';
import { validWorkerHealth } from '../../../src/worker/client';
import type { WorkerManifest } from '../../../src/worker/protocol';
import { DurableAgentAdapter } from '../../../src/worker/adapter';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function profile() { const dir = await mkdtemp(join(tmpdir(), 'discover-workers-')); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }
async function worker(dir: string, folder = 'arbitrary-folder', toolId = 'custom', sourceId = 'source', botAppId = 'app', manifest: Partial<WorkerManifest> = {}) {
  const agent: AgentAdapter = { id: toolId, displayName: 'Custom Tool', isAvailable: async () => true, run() { throw Error('No inference expected'); } };
  const server = await startWorkerServer({ stateDir: join(dir, 'workers', folder), sourceId, botAppId, agent,
    sessions: { list: async () => [{ nativeId: 'opaque:id', cwd: dir, createdAtMs: 1, updatedAtMs: 2 }], history: async nativeId => ({ nativeId, format: 'json', content: '{}' }) },
    manifest: { label: 'Custom Tool', nativeField: 'threadId', sessionKind: 'custom-chat', historyFormat: 'json', nativeHistory: false, ...manifest } });
  cleanups.push(() => server.close()); return server;
}
it('discovers an arbitrary worker directory and tool ID through authenticated common metadata', async () => {
  const dir = await profile(); await worker(dir);
  await mkdir(join(dir, 'workers', 'not-a-worker'));
  await symlink(join(dir, 'workers', 'arbitrary-folder'), join(dir, 'workers', 'linked-worker'));
  const rows = await discoverWorkers(dir, 'app'); expect(rows).toHaveLength(1);
  const tool = workerTool(rows[0]!); expect(tool.id).toBe('custom'); expect(tool.agent.displayName).toBe('Custom Tool');
  expect(nativeSessionFields(tool.id, 'opaque:id')).toEqual({ threadId: 'opaque:id' });
  expect(await tool.listSessions()).toHaveLength(1); expect(await readFile((await tool.sessions!.historyPath('opaque:id'))!, 'utf8')).toBe('{}');
});
it('starts with no workers and preserves cached identities while offline', async () => {
  const dir = await profile(); expect(await loadWorkerRegistry(dir, 'app')).toEqual([]);
  const live = await worker(dir); const rows = await loadWorkerRegistry(dir, 'app'); await live.close(); cleanups.pop();
  expect(await loadWorkerRegistry(dir, 'app')).toEqual(rows); expect(await workerTool(rows[0]!).agent.isAvailable()).toBe(false);
});
it('rejects wrong application, replaced identity, duplicate IDs, and malformed metadata', async () => {
  const dir = await profile(); await worker(dir, 'other-app', 'other', 'source', 'wrong');
  expect(await discoverWorkers(dir, 'app')).toEqual([]);
  const live = await worker(dir); const [valid] = await loadWorkerRegistry(dir, 'app');
  expect(validWorkerHealth({ ...valid!.health, manifest: { ...valid!.health.manifest, nativeField: 'filePath' } }, 'app')).toBe(false);
  expect(validWorkerHealth({ ...valid!.health, capabilities: { ...valid!.health.capabilities, questions: 'yes' } }, 'app')).toBe(false);
  expect(validWorkerHealth({ ...valid!.health, toolId: '../escape' }, 'app')).toBe(false);
  await live.close(); cleanups.pop();
  await worker(dir, 'arbitrary-folder', 'custom', 'another-source');
  expect((await loadWorkerRegistry(dir, 'app'))[0]?.health.sourceId).toBe('source');
  await worker(dir, 'second', 'custom', 'source'); expect(await loadWorkerRegistry(dir, 'app')).toEqual([]);
});
it.each([{ nativeField: 'sessionId' as const }, { sessionKind: 'replaced-chat' }])('rejects a replaced session identity on health and subsequent requests: %j', async manifest => {
  const dir = await profile(), original = await worker(dir);
  const [cached] = await loadWorkerRegistry(dir, 'app');
  const tool = workerTool(cached!);
  await original.close(); cleanups.pop();
  await worker(dir, 'arbitrary-folder', 'custom', 'source', 'app', manifest);
  expect((await loadWorkerRegistry(dir, 'app'))[0]!.health.manifest).toEqual(cached!.health.manifest);
  expect(await tool.agent.isAvailable()).toBe(false);
  await expect(tool.listSessions()).rejects.toThrow('不匹配');
  await expect((tool.agent as DurableAgentAdapter).client.snapshot('old-job')).rejects.toThrow('identity changed');
});
it('imports separate worker configuration, retains jobs, and never changes an isolated Codex home', async () => {
  const dir = await profile(); await mkdir(join(dir, 'execution-worker-kilo', 'jobs'), { recursive: true });
  await writeFile(join(dir, 'execution-worker-kilo', 'jobs', 'receipt.json'), 'immutable');
  await writeFile(join(dir, 'execution-worker-kilo', 'endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'stale' }));
  const old = createDefaultProfileConfig({ agentKind: 'kilo', accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    kilo: { binaryPath: '/native/kilo', dataHome: '/original/data' }, codex: { binaryPath: '/native/codex', inheritCodexHome: false } });
  const migrated = await migrateWorkerConfiguration(dir, old);
  expect(migrated.kilo).toBeUndefined(); expect(migrated.codex).toBeUndefined();
  expect(await readFile(join(dir, 'workers', 'kilo', 'jobs', 'receipt.json'), 'utf8')).toBe('immutable');
  expect((await loadWorkerConfig(dir, 'codex', migrated)).options.codexHome).toBe(join(dir, 'codex-home'));
  const config = (await loadWorkerConfig(dir, 'kilo', migrated)); config.options.binaryPath = '/edited';
  await writeFile(join(dir, 'workers', 'kilo', 'config.json'), JSON.stringify(config));
  await migrateWorkerConfiguration(dir, old); expect((await loadWorkerConfig(dir, 'kilo', old)).options.binaryPath).toBe('/edited');
});
it('blocks a running legacy worker migration without moving or stopping it', async () => {
  const dir = await profile(), live = await worker(dir, 'live', 'kilo');
  await mkdir(join(dir, 'execution-worker-kilo'));
  await writeFile(join(dir, 'execution-worker-kilo', 'endpoint.json'), await readFile(join(dir, 'workers', 'live', 'endpoint.json')));
  const cfg = createDefaultProfileConfig({ agentKind: 'kilo', accounts: { app: { id: 'app', secret: 's', tenant: 'feishu' } } });
  await expect(loadWorkerConfig(dir, 'kilo', cfg)).rejects.toThrow('仍在运行');
  expect(await readFile(join(dir, 'execution-worker-kilo', 'endpoint.json'), 'utf8')).toContain('token');
  expect(live.store.list()).toEqual([]);
});
it('recovers only never-submitted intake and keeps uncertain/accepted receipts immutable', async () => {
  const dir = await profile();
  const records = ['pending', 'sending', 'accepted', 'unknown', 'completed', 'rejected', 'cancelled'].map((status, i) => ({
    id: `om_${i}`, scope: 'oc_group', status, messages: [{ messageId: `om_${i}`, createTime: Date.now() + i }], createdAtMs: 1, updatedAtMs: 2,
  }));
  await writeFile(join(dir, 'codex-submissions.json'), JSON.stringify({ version: 1, records }));
  await migrateLegacyIntake(dir); const inbox = new WorkerInbox(join(dir, 'codex-inbox.json')); await inbox.load();
  expect(inbox.available().map(entry => entry.message.messageId)).toEqual(['om_0']);
  await inbox.rejectScope('oc_group'); await migrateLegacyIntake(dir); await inbox.load(); expect(inbox.available()).toEqual([]);
  for (const record of records) expect(await inbox.receive(record.scope, record.messages[0] as any)).toBe(false);
  // After expiry, a later startup must not re-import the rejected legacy pending record.
  const expired = new WorkerInbox(join(dir, 'codex-inbox.json'), () => Date.now() + 40 * 24 * 60 * 60_000); await expired.load();
  await migrateLegacyIntake(dir); await inbox.load(); expect(inbox.available()).toEqual([]);
});
it('preserves old card IDs and sequences including bridge-origin in-flight replies', async () => {
  const dir = await profile(), catalog = new SessionCatalog(join(dir, 'catalog')); await catalog.load();
  catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', sourceId: 'source', cwdRealpath: dir, policyFingerprint: 'p', threadId: 'thread' });
  const oldPath = join(dir, 'old'), newPath = join(dir, 'new');
  await writeFile(oldPath, JSON.stringify({ version: 2, threads: { thread: { turns: { turn: { origin: 'bridge', discoveredAtMs: 1, userEchoed: { oc_group: true }, deliveries: { oc_group: { status: 'card', cardId: 'card', messageId: 'message', sequence: 8 } } } } } } }));
  await migrateMirrorLedger(oldPath, newPath, 'codex', 'source', catalog);
  const state = JSON.parse(await readFile(newPath, 'utf8')), delivery = Object.values(state.bindings)[0] as any;
  expect(delivery.turns.turn).toMatchObject({ cardId: 'card', messageId: 'message', sequence: 8, legacyBridge: true, skipped: false });
  await writeFile(oldPath, 'corrupt'); await migrateMirrorLedger(oldPath, newPath, 'codex', 'source', catalog); await catalog.flush();
});

it('defaults canonical Kilo settings to vscode and accepts only one explicit client mode', async () => {
  const dir = await profile(), config = createDefaultProfileConfig({ agentKind: 'kilo', accounts: { app: { id: 'app', secret: 's', tenant: 'feishu' } } });
  expect((await loadWorkerConfig(dir, 'kilo', config)).options.client).toBe('vscode');
  const path = join(dir, 'workers/kilo/config.json');
  for (const client of ['vscode', 'app']) {
    await writeFile(path, JSON.stringify({ version: 1, toolId: 'kilo', options: { client, dataHome: '/existing' } }));
    expect((await loadWorkerConfig(dir, 'kilo', config)).options).toEqual({ client, dataHome: '/existing' });
  }
  for (const client of ['both', 'desktop', null, ['vscode', 'app']]) {
    await writeFile(path, JSON.stringify({ version: 1, toolId: 'kilo', options: { client } }));
    await expect(loadWorkerConfig(dir, 'kilo', config)).rejects.toThrow('必须配置为 vscode 或 app');
  }
});
