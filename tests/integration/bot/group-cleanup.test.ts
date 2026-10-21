import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { saveRootConfig, loadRootConfig } from '../../../src/config/profile-store';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { chatIsDissolved, createGroupCleanup } from '../../../src/bot/group-cleanup';
import { syncAaSessionGroupsOnce } from '../../../src/bot/aa-session-groups';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'group-cleanup-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const catalog = new SessionCatalog(join(dir, 'catalog.json')); await catalog.load();
  const sessions = new SessionStore(join(dir, 'sessions.json')); await sessions.load();
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json')); await workspaces.load();
  const bindings = new ToolBindingStore(join(dir, 'bindings.json')); await bindings.load();
  cleanup.push(() => Promise.all([catalog.flush(), sessions.flush(), workspaces.flush(), bindings.flush()]));
  const get = vi.fn(async (_p: unknown): Promise<{ code: number; data?: { chat_status?: string } }> => ({ code: 0, data: { chat_status: 'normal' } }));
  const create = vi.fn();
  const channel = { listChats: vi.fn(async () => []), rawClient: { im: { v1: { chat: { get, create } } } } } as unknown as LarkChannel;
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'bot', secret: 'test', tenant: 'feishu' } }, codex: { binaryPath: 'codex' },
    access: { admins: ['ou_owner'], allowedChats: ['*', 'oc_dead', 'oc_live'] },
  });
  const configPath = join(dir, 'config.json');
  await saveRootConfig({ schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: profileConfig } }, configPath);
  const controls = { profile: 'test', profileConfig, configPath, toolBindings: bindings, botOwnerId: 'ou_owner',
    knownChats: [{ id: 'oc_dead', name: 'AA-old' }, { id: 'oc_live', name: 'AA-live' }],
  } as unknown as Controls;
  const cancelPending = vi.fn(async (_scope: string) => {});
  const add = (scope: string, nativeId = 'shared', botAppId = 'bot') => {
    catalog.upsertActive({ scopeId: scope, agentId: 'codex', threadId: nativeId, sourceId: 'legacy',
      cwdRealpath: dir, policyFingerprint: scope, botAppId });
    bindings.set(scope, { toolId: 'codex', sourceId: 'legacy', nativeId });
    sessions.set(scope, nativeId, dir); workspaces.setCwd(scope, dir);
  };
  const deps = { channel, controls, catalog, sessions, workspaces, cancelPending };
  const start = (extra = {}) => {
    const handle = createGroupCleanup({ ...deps, ...extra }); cleanup.push(() => handle.stop()); return handle;
  };
  return { dir, catalog, sessions, workspaces, bindings, controls, channel, get, create, configPath, add, cancelPending, start, deps };
}

it.each(['dissolved', 'dissolved_save'])('cleans %s group/topic routes while keeping shared native history and other groups', async chat_status => {
  const h = await fixture(); h.add('oc_dead'); h.add('oc_dead:topic'); h.add('oc_live');
  h.sessions.set('oc_dead:session-only', 'shared', h.dir);
  h.get.mockImplementation(async (p: any) => ({ code: 0, data: { chat_status: p.path.chat_id === 'oc_dead' ? chat_status : 'normal' } }));
  const scan = h.start(); await scan.runNow();
  expect(h.bindings.get('oc_dead')).toBeUndefined(); expect(h.bindings.get('oc_dead:topic')).toBeUndefined();
  expect(h.sessions.getRaw('oc_dead:session-only')).toBeUndefined(); expect(h.workspaces.cwdFor('oc_dead')).toBeUndefined();
  expect(h.catalog.entries().filter(row => row.scopeId.startsWith('oc_dead')).every(row => row.status === 'archived')).toBe(true);
  expect(h.catalog.isScopeArchived('oc_dead:topic')).toBe(true);
  expect(h.catalog.isThreadArchived('shared')).toBe(false);
  expect(h.catalog.entries().find(row => row.scopeId === 'oc_live')?.status).toBe('active');
  expect(h.bindings.get('oc_live')?.nativeId).toBe('shared');
  expect(h.cancelPending.mock.calls.map(call => call[0]).sort()).toEqual(['oc_dead', 'oc_dead:session-only', 'oc_dead:topic']);
  expect((await loadRootConfig(h.configPath))?.profiles.test?.access.allowedChats).toEqual(['*', 'oc_live']);
  expect(h.controls.knownChats?.map(chat => chat.id)).toEqual(['oc_live']);
  await scan.runNow(); expect(h.get.mock.calls.filter(([p]: any[]) => p.path.chat_id === 'oc_dead')).toHaveLength(1);
});

it.each([232006, 232011, 232010, 99991672, 99991679, 99991400])('preserves a group when lookup returns %s', async code => {
  const h = await fixture(); h.add('oc_dead'); h.get.mockResolvedValue({ code }); await h.start().runNow();
  expect(h.bindings.get('oc_dead')?.nativeId).toBe('shared'); expect(h.catalog.isChatDissolved('oc_dead')).toBe(false);
  expect(h.cancelPending).not.toHaveBeenCalled();
});

it.each([{ code: 0 }, { code: 0, data: {} }, { code: 0, data: { chat_status: 'unknown' } }])('preserves groups with partial or unknown responses: %j', async result => {
  const h = await fixture(); h.add('oc_dead'); h.get.mockResolvedValue(result); await h.start().runNow();
  expect(h.bindings.get('oc_dead')).toBeDefined(); expect(h.cancelPending).not.toHaveBeenCalled();
});

it('preserves bindings on network failure and does not infer deletion from a missing chat-list entry', async () => {
  const h = await fixture(); h.add('oc_dead'); h.get.mockRejectedValue(new Error('timeout')); await h.start().runNow();
  expect(h.bindings.get('oc_dead')).toBeDefined(); expect(h.catalog.isChatDissolved('oc_dead')).toBe(false);
});

it.each([false, true])('recognizes a dissolved error returned or thrown by the SDK (throw: %s)', async throws => {
  const h = await fixture();
  if (throws) h.get.mockRejectedValue({ response: { data: { code: 232009 } } }); else h.get.mockResolvedValue({ code: 232009 });
  await expect(chatIsDissolved(h.channel, 'oc_dead')).resolves.toBe(true);
});

it('keeps dissolution and auto-group suppression across GC/restart without archiving the native source', async () => {
  const h = await fixture(); h.add('oc_dead'); h.get.mockResolvedValue({ code: 232009 });
  await h.start().runNow(); h.catalog.gc({ maxEntriesPerProfile: 0 }); await h.catalog.flush();
  const loaded = new SessionCatalog(join(h.dir, 'catalog.json')); await loaded.load();
  expect(loaded.isChatDissolved('oc_dead')).toBe(true); expect(loaded.isAutoGroupSuppressed('codex', 'legacy', 'shared')).toBe(true);
  expect(loaded.isScopeArchived('oc_dead:new-topic')).toBe(true);
  expect(loaded.isThreadArchived('shared')).toBe(false);
  expect(() => loaded.upsertActive({ scopeId: 'oc_dead', agentId: 'codex', threadId: 'new',
    cwdRealpath: h.dir, policyFingerprint: 'new', rebindArchivedScope: true })).toThrow('已解散');
  await syncAaSessionGroupsOnce({ channel: h.channel, controls: h.controls, sessionCatalog: loaded,
    workspaces: h.workspaces, profileStateDir: h.dir, historyProvider: async () => [{
      threadId: 'shared', name: 'AA-old', cwd: h.dir, preview: '', source: 'exec', createdAtMs: 1, updatedAtMs: 2,
    }],
  });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.channel.listChats).toHaveBeenCalled();
});

it.each(['claude', 'kilo', 'zcode', 'dsh'] as const)('cleans %s routes and suppresses replacement without native archival', async agentId => {
  const h = await fixture();
  h.catalog.upsertActive({ scopeId: 'oc_dead', agentId, sessionId: 'native', sourceId: 'tool-home',
    cwdRealpath: h.dir, policyFingerprint: 'fp', botAppId: 'bot' });
  h.bindings.set('oc_dead', { toolId: agentId, sourceId: 'tool-home', nativeId: 'native' });
  h.get.mockResolvedValue({ code: 232009 }); await h.start().runNow();
  expect(h.bindings.get('oc_dead')).toBeUndefined(); expect(h.bindings.isArchived(agentId, 'tool-home', 'native')).toBe(false);
  expect(h.catalog.isAutoGroupSuppressed(agentId, 'tool-home', 'native')).toBe(true);
});

it('recovers a cleanup interrupted after the persistent tombstone was written', async () => {
  const h = await fixture(); h.add('oc_dead'); h.get.mockResolvedValue({ code: 232009 });
  h.cancelPending.mockRejectedValueOnce(new Error('disk full')); await h.start().runNow();
  expect(h.catalog.isChatDissolved('oc_dead')).toBe(true); expect(h.bindings.get('oc_dead')).toBeDefined();
  h.get.mockRejectedValue(new Error('offline')); await h.start().runNow();
  expect(h.bindings.get('oc_dead')).toBeUndefined();
});

it('does not probe bindings owned by another bot or synthetic/p2p scopes', async () => {
  const h = await fixture(); h.add('oc_foreign', 'other', 'other-bot'); h.add('a2a_job');
  h.get.mockResolvedValue({ code: 232009 }); await h.start().runNow();
  expect(h.get.mock.calls.map(([p]: any[]) => p.path.chat_id)).not.toContain('oc_foreign');
  expect(h.get.mock.calls.map(([p]: any[]) => p.path.chat_id)).not.toContain('a2a_job');
  expect(h.bindings.get('oc_foreign')).toBeDefined(); expect(h.bindings.get('a2a_job')).toBeDefined();
});

it('serializes scans, rotates bounded batches and stops before applying an in-flight probe', async () => {
  const h = await fixture(); const scan = h.start({ batchSize: 1 });
  await scan.runNow(); await scan.runNow();
  expect(h.get.mock.calls.map(([p]: any[]) => p.path.chat_id)).toEqual(['oc_dead', 'oc_live']);
  let release!: (r: { code: number }) => void;
  h.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const running = scan.runNow(); expect(scan.runNow()).toBe(running);
  const stopping = scan.stop(); release({ code: 232009 }); await stopping;
  expect(h.catalog.isChatDissolved('oc_dead')).toBe(false);
});

it('checks on startup and automatically cleans a group dissolved before the next interval', async () => {
  const h = await fixture(); h.add('oc_dead');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const scan = h.start({ intervalMs: 1000 }); await scan.start();
  expect(h.catalog.isChatDissolved('oc_dead')).toBe(false);
  h.get.mockImplementation(async (p: any) => ({ code: p.path.chat_id === 'oc_dead' ? 232009 : 0, data: { chat_status: 'normal' } }));
  await vi.advanceTimersByTimeAsync(1000); await scan.runNow();
  expect(h.catalog.isChatDissolved('oc_dead')).toBe(true); expect(h.bindings.get('oc_dead')).toBeUndefined();
  await scan.stop(); const calls = h.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000); expect(h.get).toHaveBeenCalledTimes(calls);
});

it('closes an auxiliary route without dropping its shared canonical binding or auto-group suppressing the source', async () => {
  const h = await fixture();
  const source = { toolId: 'codex' as const, sourceId: 'legacy', nativeId: 'shared' };
  h.bindings.set('aux_shared', { ...source, linkedSource: source });
  h.bindings.linkAuxiliary('oc_dead', 'aux_shared'); h.bindings.linkAuxiliary('oc_live', 'aux_shared');
  const closeDissolvedChat = vi.fn(async () => {});
  h.controls.auxiliary = { groupIds: () => ['oc_dead', 'oc_live'], isAuxiliary: () => true, closeDissolvedChat } as any;
  h.get.mockImplementation(async (p: any) => ({ code: p.path.chat_id === 'oc_dead' ? 232009 : 0, data: { chat_status: 'normal' } }));
  await h.start().runNow();
  expect(closeDissolvedChat).toHaveBeenCalledWith('oc_dead'); expect(h.bindings.get('oc_dead')).toBeUndefined();
  expect(h.bindings.get('oc_live')?.nativeId).toBe('shared'); expect(h.bindings.get('aux_shared')).toBeDefined();
  expect(h.catalog.isAutoGroupSuppressed('codex', 'legacy', 'shared')).toBe(false);
  expect(JSON.parse(await readFile(join(h.dir, 'bindings.json'), 'utf8')).bindings.oc_dead).toBeUndefined();
});
