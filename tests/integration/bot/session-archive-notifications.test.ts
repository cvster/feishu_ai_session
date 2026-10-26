import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { startSessionArchiveNotifications } from '../../../src/bot/session-archive-notifications';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ToolRegistry } from '../../../src/tools/types';
import { syncAaSessionGroupsOnce } from '../../../src/bot/aa-session-groups';
import { startNativeTurnSync } from '../../../src/bot/native-turn-sync';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(toolId: 'codex' | 'claude' | 'kilo' | 'zcode' | 'dsh' = 'codex') {
  const tmp = await createTmpProfile('archive-notice-'); cleanup.push(() => tmp.cleanup());
  const path = join(tmp.profile, 'catalog.json');
  let catalog = new SessionCatalog(path); await catalog.load();
  cleanup.push(() => catalog.flush());
  const bindings = new ToolBindingStore(join(tmp.profile, 'bindings.json')); await bindings.load();
  cleanup.push(() => bindings.flush());
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'bot', secret: 'test', tenant: 'feishu' } } });
  const controls = { profileConfig: profile, toolBindings: bindings, botOwnerId: 'ou_owner' } as Controls;
  const channel = createFakeChannel();
  const originalCreate = channel.rawClient.im.v1.message.create;
  const create = vi.spyOn(channel.rawClient.im.v1.message, 'create');
  const add = (scopeId: string, nativeId = 'native', overrides: { sourceId?: string; botAppId?: string; shared?: boolean } = {}) => {
    const sourceId = overrides.sourceId ?? 'source';
    bindings.set(scopeId, { toolId, sourceId, nativeId,
      ...(overrides.shared ? { linkedSource: { toolId, sourceId, nativeId } } : {}) });
    catalog.upsertActive({ scopeId, agentId: toolId, sourceId, botAppId: overrides.botAppId ?? 'bot', cwdRealpath: tmp.workspace,
      policyFingerprint: scopeId, ...(toolId === 'codex' ? { threadId: nativeId } : { sessionId: nativeId }) });
  };
  let clock = 1000;
  const start = () => {
    const handle = startSessionArchiveNotifications({ channel: channel as unknown as LarkChannel, controls, catalog,
      intervalMs: 60_000, now: () => clock });
    cleanup.push(() => handle.stop()); return handle;
  };
  const archive = () => toolId === 'codex' ? catalog.archiveCodexThread('native') : catalog.archiveNativeSession(toolId, 'native', 'source', true);
  return { tmp, controls, bindings, channel, create, originalCreate, add, archive, start, path, get catalog() { return catalog; },
    advance: (value: number) => { clock = value; },
    reload: async () => { await catalog.flush(); catalog = new SessionCatalog(path); await catalog.load(); } };
}

it('persists an archive before notifying its current personal group, then stays quiet across polling and restart', async () => {
  const h = await fixture(); h.add('oc_personal'); h.add('oc_shared', 'native', { shared: true });
  h.add('oc_other', 'different'); h.add('oc_foreign', 'native', { botAppId: 'other-bot', shared: true });
  h.archive();
  const original = h.originalCreate;
  h.create.mockImplementation(async params => {
    const state = JSON.parse(await readFile(`${h.path}.archives.json`, 'utf8'));
    expect(state.threads).toContain('native'); expect(state.notifications).toContainEqual(expect.objectContaining({ id: (params as any).data.uuid }));
    const stored = JSON.parse(await readFile(h.path, 'utf8'));
    expect(stored.current.oc_personal).toBeUndefined();
    expect(stored.history.find((r: any) => r.scopeId === 'oc_personal').status).toBe('archived');
    return original(params);
  });
  const first = h.start(); await first.flush();
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.create.mock.calls[0]![0]).toMatchObject({ params: { receive_id_type: 'chat_id' },
    data: { receive_id: 'oc_personal', msg_type: 'interactive' } });
  const content = JSON.parse((h.create.mock.calls[0]![0] as any).data.content);
  expect(content.body.elements[0]).toEqual({ tag: 'markdown', content: '<at id=ou_owner></at> 会话已归档。' });
  expect(content.body.elements[1]).toMatchObject({ tag: 'button', type: 'danger', text: { content: '解散群' },
    behaviors: [{ type: 'callback', value: { cmd: 'archive-group.confirm', arg: expect.stringMatching(/^[a-f0-9]{64}$/) } }] });
  h.archive(); await first.flush(); expect(h.create).toHaveBeenCalledOnce();
  await first.stop(); await h.reload(); h.archive(); await h.start().flush(); expect(h.create).toHaveBeenCalledOnce();
  expect(h.catalog.pendingArchiveNotifications()).toEqual([]);
});

it('still sends the archive notice when the owner identity is unavailable', async () => {
  const h = await fixture(); h.controls.botOwnerId = undefined;
  h.add('oc_personal'); h.archive(); await h.start().flush();
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.create.mock.calls[0]![0]).toMatchObject({ data: {
    msg_type: 'interactive',
  } });
  const card = JSON.parse((h.create.mock.calls[0]![0] as any).data.content);
  expect(card.body.elements[0].content).toBe('会话已归档。'); expect(card.body.elements[1].text.content).toBe('解散群');
  expect(h.catalog.pendingArchiveNotifications()).toEqual([]);
});

it('recovers a pending notification after restart and retries an uncertain receipt with the same uuid', async () => {
  const h = await fixture(); h.add('oc_group'); h.archive(); await h.reload();
  const seen = new Map<string, unknown>(); const original = h.originalCreate;
  h.create.mockImplementation(async params => {
    const id = (params as any).data.uuid;
    if (seen.has(id)) return seen.get(id);
    const result = await original(params); seen.set(id, result); throw new Error('lost receipt');
  });
  const first = h.start(); await first.flush();
  expect(h.create).toHaveBeenCalledOnce(); expect(h.catalog.pendingArchiveNotifications()).toHaveLength(1);
  await first.stop(); await h.reload(); const second = h.start(); await second.flush();
  expect(h.create).toHaveBeenCalledTimes(2); expect(seen.size).toBe(1); expect(h.channel.sent).toHaveLength(1);
  expect((h.create.mock.calls[0]![0] as any).data.uuid).toBe((h.create.mock.calls[1]![0] as any).data.uuid);
  expect((h.create.mock.calls[0]![0] as any).data.content).toBe((h.create.mock.calls[1]![0] as any).data.content);
  expect(JSON.parse((h.create.mock.calls[1]![0] as any).data.content).body.elements[0].content)
    .toBe('<at id=ou_owner></at> 会话已归档。');
  expect(h.catalog.pendingArchiveNotifications()).toEqual([]);
});

it('pauses uncertain retries beyond the platform deduplication window', async () => {
  const h = await fixture(); h.add('oc_group'); h.archive();
  h.create.mockRejectedValue(new Error('timeout')); const handle = h.start(); await handle.flush();
  h.advance(1000 + 55 * 60_000); await handle.flush();
  expect(h.create).toHaveBeenCalledOnce(); expect(h.catalog.pendingArchiveNotifications()).toHaveLength(1);
});

it.each(['rebound', 'dissolved', 'account', 'source'] as const)('does not notify an outdated %s destination', async mode => {
  const h = await fixture(); h.add('oc_group'); h.archive();
  if (mode === 'rebound') {
    h.bindings.set('oc_group', { toolId: 'codex', sourceId: 'source', nativeId: 'new' });
    h.catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', sourceId: 'source', botAppId: 'bot', threadId: 'new',
      cwdRealpath: h.tmp.workspace, policyFingerprint: 'new', rebindArchivedScope: true });
  }
  if (mode === 'dissolved') h.catalog.markChatDissolved('oc_group', []);
  if (mode === 'account') h.controls.profileConfig.accounts.app.id = 'other';
  if (mode === 'source') {
    const tools = new ToolRegistry(); tools.register({ id: 'codex', sourceId: 'different-source', label: 'Codex',
      agent: new FakeAgentAdapter({ id: 'codex' }), listSessions: async () => [] }); h.controls.toolRegistry = tools;
  }
  await h.start().flush(); expect(h.create).not.toHaveBeenCalled(); expect(h.catalog.pendingArchiveNotifications()).toEqual([]);
});

it('does not treat binding retirement, reset or group dissolution as conversation archival', async () => {
  const h = await fixture('kilo'); h.add('oc_group');
  h.catalog.archiveNativeSession('kilo', 'native', 'source');
  h.catalog.markChatDissolved('oc_group', []); await h.start().flush();
  expect(h.create).not.toHaveBeenCalled(); expect(h.catalog.pendingArchiveNotifications()).toEqual([]);
});

it.each(['claude', 'kilo', 'zcode', 'dsh'] as const)('notifies %s bridge archival once and permits a new notification after explicit rebinding', async toolId => {
  const h = await fixture(toolId); h.add('oc_group'); h.archive(); const handle = h.start(); await handle.flush();
  h.archive(); await handle.flush(); expect(h.create).toHaveBeenCalledOnce();
  h.catalog.upsertActive({ scopeId: 'oc_group', agentId: toolId, sourceId: 'source', botAppId: 'bot', sessionId: 'native',
    cwdRealpath: h.tmp.workspace, policyFingerprint: 'oc_group', rebindArchivedScope: true });
  h.archive(); await handle.flush(); expect(h.create).toHaveBeenCalledTimes(2);
  expect((h.create.mock.calls[0]![0] as any).data.uuid).not.toBe((h.create.mock.calls[1]![0] as any).data.uuid);
});

it.each(['kilo', 'zcode', 'dsh'] as const)('detects explicit %s native archival from the existing session scan, without inferring it from missing rows', async toolId => {
  const h = await fixture(toolId); h.add('oc_group');
  const listSessions = vi.fn(async () => [] as any[]);
  const tools = new ToolRegistry(); tools.register({ id: toolId, sourceId: 'source', label: toolId,
    agent: new FakeAgentAdapter({ id: toolId }), listSessions }); h.controls.toolRegistry = tools;
  const notifications = h.start(); h.controls.sessionArchiveNotifications = notifications;
  const deps = { channel: h.channel as unknown as LarkChannel, controls: h.controls, sessionCatalog: h.catalog,
    workspaces: new WorkspaceStore(join(h.tmp.profile, 'workspaces.json')), profileStateDir: h.tmp.profile };
  await syncAaSessionGroupsOnce(deps); expect(h.create).not.toHaveBeenCalled(); expect(h.catalog.isScopeArchived('oc_group')).toBe(false);
  listSessions.mockRejectedValueOnce(new Error('worker unavailable')); await syncAaSessionGroupsOnce(deps);
  expect(h.create).not.toHaveBeenCalled(); expect(h.catalog.isScopeArchived('oc_group')).toBe(false);
  listSessions.mockResolvedValue([{ nativeId: 'native', cwd: h.tmp.workspace, createdAtMs: 1, updatedAtMs: 2, archived: true }]);
  await syncAaSessionGroupsOnce(deps); await syncAaSessionGroupsOnce(deps);
  expect(h.create).toHaveBeenCalledOnce(); expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
  expect(h.bindings.isArchived(toolId, 'source', 'native')).toBe(true);
});

it.each(['kilo', 'zcode'] as const)('detects confirmed %s snapshot archival only for a matching project', async toolId => {
  const h = await fixture(toolId); h.add('oc_group');
  const notifications = h.start(); h.controls.sessionArchiveNotifications = notifications;
  const snapshot = { id: 'native', cwd: h.tmp.workspace, archived: false, turns: [] };
  const reader = { read: vi.fn(async () => structuredClone(snapshot)), close: vi.fn(async () => {}) };
  const sync = await startNativeTurnSync({ toolId, displayName: toolId, channel: h.channel as unknown as LarkChannel,
    controls: h.controls, catalog: h.catalog, sourceId: 'source', reader, intervalMs: 60_000, statePath: join(h.tmp.profile, 'native-sync.json') });
  cleanup.push(() => sync.stop());
  snapshot.archived = true; snapshot.cwd = '/other/project'; await sync.runNow();
  expect(h.create).not.toHaveBeenCalled(); expect(h.catalog.isScopeArchived('oc_group')).toBe(false);
  snapshot.cwd = h.tmp.workspace; await sync.runNow(); await sync.runNow();
  expect(h.create).toHaveBeenCalledOnce(); expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
});
