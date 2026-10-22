import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { ToolBindingStore, type ToolBinding } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { startKiloTurnSync } from '../../../src/bot/kilo-turn-sync';
import { SessionNameSync } from '../../../src/bot/thread-name';
import { initialState } from '../../../src/card/run-state';
import { type KiloConversationSnapshot, type KiloConversationTurn } from '../../../src/agent/kilo/conversation';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function turn(id = 'msg_external', createdAtMs = 2000, running = false): KiloConversationTurn {
  return { id, createdAtMs, bridge: false, input: 'native question', state: {
    ...structuredClone(initialState), terminal: running ? 'running' : 'done', footer: null,
    blocks: [{ kind: 'text', content: 'native answer', streaming: running }],
  } };
}
async function fixture(mode: 'card' | 'markdown' | 'text' = 'card') {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-turn-sync-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const bindings = new ToolBindingStore(join(dir, 'bindings.json')); await bindings.load();
  const catalog = new SessionCatalog(join(dir, 'catalog.json')); await catalog.load();
  cleanup.push(async () => { await bindings.flush(); await catalog.flush(); });
  const add = (scope: string, id: string, extra: Partial<ToolBinding> = {}) => {
    bindings.set(scope, { toolId: 'kilo', sourceId: 'local-kilo', nativeId: id, ...extra });
    catalog.upsertActive({ scopeId: scope, agentId: 'kilo', cwdRealpath: dir, policyFingerprint: scope, sessionId: id, sourceId: 'local-kilo', botAppId: 'cli_test' });
  };
  add('oc_group', 'ses_native');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true }, accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls = { profileConfig: profile, toolBindings: bindings, cfg: { preferences: { messageReply: mode, messageReplyMigrated: true } } } as unknown as Controls;
  const snapshots: Record<string, KiloConversationSnapshot> = { ses_native: { id: 'ses_native', cwd: dir, archived: false, turns: [turn('old', 500)] } };
  const reader = { read: vi.fn(async (id: string) => structuredClone(snapshots[id]!)), stopTurn: vi.fn(async () => true), close: vi.fn(async () => {}) };
  const create = vi.fn(async (..._args: any[]) => ({ code: 0, data: { message_id: `om_${create.mock.calls.length}` } }));
  const patch = vi.fn(async () => ({ code: 0 }));
  const channel = { createCard: vi.fn(async () => ({ cardId: 'card_one' })), updateCardById: vi.fn(async () => {}), rawClient: { im: { v1: { message: { create, patch } } } } } as unknown as LarkChannel;
  let clock = 1000;
  const statePath = join(dir, 'sync.json');
  const ready = vi.fn(async () => true);
  const start = async (nameSync?: Pick<SessionNameSync, 'observe'>) => {
    const handle = await startKiloTurnSync({ channel, controls, catalog, sourceId: 'local-kilo', reader, statePath, intervalMs: 60_000, now: () => clock, ready, nameSync });
    cleanup.push(() => handle.stop()); return handle;
  };
  return { dir, bindings, catalog, add, controls, snapshots, reader, create, patch, channel, start, statePath, ready, now: () => clock, advance: (value: number) => { clock = value; } };
}
it('baselines old history, mirrors an external turn once and continues the same card after restart', async () => {
  const h = await fixture(), first = await h.start(); expect(h.create).not.toHaveBeenCalled();
  h.advance(3000); h.snapshots.ses_native!.turns.push(turn(undefined, 2000, true)); await first.runNow();
  expect(h.create).toHaveBeenCalledTimes(2); expect(h.create.mock.calls.every(([r]) => r.data.receive_id === 'oc_group')).toBe(true);
  expect(JSON.stringify(h.create.mock.calls[0])).toContain('native question'); expect(h.channel.createCard).toHaveBeenCalledOnce();
  await first.runNow(); expect(h.create).toHaveBeenCalledTimes(2); const sequence = vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![2];
  await first.stop(); const second = await h.start();
  h.snapshots.ses_native!.turns.at(-1)!.state.terminal = 'done'; await second.runNow();
  expect(h.create).toHaveBeenCalledTimes(2); expect(h.channel.createCard).toHaveBeenCalledOnce();
  expect(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![2]).toBeGreaterThan(sequence);
  const message = h.create.mock.results[1]!.value; const id = (await message).data.message_id;
  expect(await second.refreshMessage('oc_group', id)).toBe(true);
});
it('never duplicates Feishu-origin input or answers, even when their text matches an external input', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000);
  h.snapshots.ses_native!.turns.push({ ...turn('msg_bridge'), bridge: true }, turn()); await sync.runNow();
  expect(h.create).toHaveBeenCalledTimes(2);
});
it('routes VS Code and Desktop native sessions only to their respective bound personal groups', async () => {
  const h = await fixture(); h.add('oc_desktop', 'ses_desktop'); h.snapshots.ses_desktop = { ...h.snapshots.ses_native!, id: 'ses_desktop', turns: [] };
  const sync = await h.start(); h.advance(3000);
  h.snapshots.ses_native!.turns.push(turn()); h.snapshots.ses_desktop.turns.push(turn('desktop')); await sync.runNow();
  expect(h.create.mock.calls.map(([r]) => r.data.receive_id)).toEqual(['oc_group', 'oc_group', 'oc_desktop', 'oc_desktop']);
});
it('excludes FF shared groups and FF owner workgroups from unsolicited mirroring', async () => {
  const h = await fixture();
  for (const scope of ['oc_ff', 'oc_ffowner']) {
    h.add(scope, 'ses_native', { linkedSource: { toolId: 'kilo', sourceId: 'local-kilo', nativeId: 'ses_source', historyPath: '/history' } }); const binding = h.bindings.get(scope)!;
    h.bindings.set(scope, { ...binding, linkedSource: { toolId: 'kilo', sourceId: 'local-kilo', nativeId: 'ses_source', historyPath: '/history' }, auxiliaryWorkgroup: scope === 'oc_ffowner' });
  }
  const sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn()); await sync.runNow();
  expect(h.create.mock.calls.map(([r]) => r.data.receive_id)).toEqual(['oc_group', 'oc_group']);
});
it.each(['archive', 'binding', 'cwd', 'app'] as const)('fails closed when the %s no longer matches the active binding', async kind => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn());
  if (kind === 'archive') h.catalog.archiveScope('oc_group', 'ses_native');
  if (kind === 'binding') h.bindings.set('oc_group', { ...h.bindings.get('oc_group')!, nativeId: 'ses_other' });
  if (kind === 'cwd') h.snapshots.ses_native!.cwd = '/different/project';
  if (kind === 'app') h.controls.profileConfig.accounts.app.id = 'another_app';
  await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
});
it('does not send if the group is archived while a card is being created', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push({ ...turn(), input: '' });
  vi.mocked(h.channel.createCard).mockImplementationOnce(async () => { h.catalog.archiveScope('oc_group', 'ses_native'); return { cardId: 'card_one' }; });
  await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
});
it('uses stable deduplication IDs for an ambiguous send and stops retrying outside the Feishu window', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn());
  h.create.mockRejectedValueOnce(Error('connection lost')); await sync.runNow(); await sync.runNow();
  expect(h.create.mock.calls[0]![0].data.uuid).toBe(h.create.mock.calls[1]![0].data.uuid); expect(h.create).toHaveBeenCalledTimes(3);
  await sync.stop(); const ledger = JSON.parse(await readFile(h.statePath, 'utf8'));
  for (const binding of Object.values(ledger.bindings) as any[]) for (const delivery of Object.values(binding.turns) as any[]) if (!delivery.skipped) { delete delivery.inputMessageId; delivery.inputSendingAt = 1; }
  await writeFile(h.statePath, JSON.stringify(ledger)); h.advance(60 * 60_000); const resumed = await h.start(); await resumed.runNow();
  expect(h.create).toHaveBeenCalledTimes(3);
});
it('stops only a mirrored external current turn and never stops a worker-owned or newly rebound turn', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn(undefined, 2000, true)); await sync.runNow();
  expect(await sync.stopScope('oc_group')).toBe(true); expect(h.reader.stopTurn).toHaveBeenCalledWith('ses_native', 'msg_external');
  h.snapshots.ses_native!.turns.push({ ...turn('msg_bridge', 2500, true), bridge: true }); expect(await sync.stopScope('oc_group')).toBe(false);
  expect(h.reader.stopTurn).toHaveBeenCalledOnce();
});
it.each(['markdown', 'text'] as const)('preserves %s reply behavior', async mode => {
  const h = await fixture(mode), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn(undefined, 2000, true)); await sync.runNow();
  expect(h.create).toHaveBeenCalledTimes(mode === 'text' ? 1 : 2); h.snapshots.ses_native!.turns.at(-1)!.state.terminal = 'done'; await sync.runNow();
  expect(h.create).toHaveBeenCalledTimes(2); expect(h.channel.createCard).not.toHaveBeenCalled();
});
it('does not read or baseline conversations until the worker can mark bridge input provenance', async () => {
  const h = await fixture(); h.ready.mockResolvedValue(false); const sync = await h.start(); expect(h.reader.read).not.toHaveBeenCalled();
  h.ready.mockResolvedValue(true); await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
});
it('re-establishes a history baseline when the group is explicitly rebound to the same native session', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn()); await sync.runNow();
  expect(h.create).toHaveBeenCalledTimes(2);
  h.snapshots.ses_native!.turns.push(turn('during-unbound', 3200));
  const entry = h.catalog.entries().find(row => row.scopeId === 'oc_group')!;
  h.catalog.upsertActive({ ...entry, now: 3500 }); h.advance(4000); await sync.runNow(); expect(h.create).toHaveBeenCalledTimes(2);
  h.snapshots.ses_native!.turns.push(turn('after-rebind', 5000)); h.advance(6000); await sync.runNow(); expect(h.create).toHaveBeenCalledTimes(4);
});
it.each(['archive', 'source'] as const)('never mirrors when the native %s is incompatible with the binding', async kind => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshots.ses_native!.turns.push(turn());
  if (kind === 'archive') h.snapshots.ses_native!.archived = true;
  else {
    const entry = h.catalog.entries().find(row => row.scopeId === 'oc_group')!;
    h.catalog.upsertActive({ ...entry, sourceId: 'different-source' });
  }
  await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
  if (kind === 'archive') expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
});

it('synchronizes personal group names in both directions, including the pre-install rename, without starting a model turn', async () => {
  const h = await fixture(); let groupName = '群里刚改的名字'; h.snapshots.ses_native!.name = '原会话名';
  h.channel.getChatMode = vi.fn(async () => 'group') as any;
  h.channel.getChatInfo = vi.fn(async () => ({ name: groupName })) as any;
  const update = vi.fn(async (request: any) => { groupName = request.data.name; return { code: 0 }; });
  (h.channel.rawClient.im.v1 as any).chat = { update };
  const renameSession = vi.fn(async (id: string, name: string) => { h.snapshots[id]!.name = name; });
  const syncNames = () => new SessionNameSync({ channel: h.channel, toolId: 'kilo', sourceId: 'local-kilo', appId: 'cli_test',
    statePath: join(h.dir, 'names.json'), renameSession, now: h.now });
  let names = syncNames(); await names.load(); const first = await h.start(names);
  expect(renameSession).toHaveBeenCalledWith('ses_native', '群里刚改的名字'); expect(h.create).not.toHaveBeenCalled();
  groupName = '再次改群名'; h.advance(12000); await first.runNow(); expect(h.snapshots.ses_native!.name).toBe('再次改群名');
  h.snapshots.ses_native!.name = '桌面改的名字'; await first.runNow(); expect(groupName).toBe('桌面改的名字');
  expect(update).toHaveBeenCalledOnce(); await first.stop();
  names = syncNames(); await names.load(); const resumed = await h.start(names); await resumed.runNow();
  expect(renameSession).toHaveBeenCalledTimes(2); expect(update).toHaveBeenCalledOnce(); expect(h.create).not.toHaveBeenCalled();
});
it('does not let multiple personal groups fight over one native title and never includes FF audiences', async () => {
  const h = await fixture(); h.add('oc_ff', 'ses_native', { linkedSource: { toolId: 'kilo', sourceId: 'local-kilo', nativeId: 'ses_source', historyPath: '/history' } });
  h.bindings.set('oc_ff', { ...h.bindings.get('oc_ff')!, linkedSource: { toolId: 'kilo', sourceId: 'local-kilo', nativeId: 'ses_source', historyPath: '/history' } });
  const observe = vi.fn(async (..._args: any[]) => {}); const sync = await h.start({ observe });
  expect(observe).toHaveBeenCalledOnce(); expect(observe.mock.calls[0]![1].map((e: any) => e.scopeId)).toEqual(['oc_group']);
  observe.mockClear();
  await h.bindings.flush();
  await writeFile(join(h.dir, 'bindings.json'), JSON.stringify({ version: 1, archived: [], bindings: {
    ...Object.fromEntries(h.bindings.entries()), oc_duplicate: { toolId: 'kilo', sourceId: 'local-kilo', nativeId: 'ses_native' },
  } }));
  await h.bindings.load();
  h.catalog.upsertActive({ scopeId: 'oc_duplicate', agentId: 'kilo', sourceId: 'local-kilo', sessionId: 'ses_native', cwdRealpath: h.dir, policyFingerprint: 'duplicate', botAppId: 'cli_test' });
  await sync.runNow(); expect(observe).not.toHaveBeenCalled();
});
it('continues reply mirroring when the independent name synchronization fails', async () => {
  const h = await fixture(); const observe = vi.fn(async () => { throw Error('name service offline'); });
  const sync = await h.start({ observe }); h.advance(3000); h.snapshots.ses_native!.turns.push(turn()); await sync.runNow();
  expect(observe).toHaveBeenCalled(); expect(h.create).toHaveBeenCalledTimes(2);
});
