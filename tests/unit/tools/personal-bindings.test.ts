import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonalBindingConflict, ToolBindingStore, type ToolBinding } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { nativeSessionFields } from '../../../src/tools/definitions';
import type { AgentKind } from '../../../src/config/profile-schema';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(enforce = true) {
  const dir = await mkdtemp(join(tmpdir(), 'personal-binding-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bindings.json');
  const store = new ToolBindingStore(path), catalog = new SessionCatalog(join(dir, 'catalog.json'));
  await store.load(); await catalog.load();
  cleanups.push(async () => { await store.flush(); await catalog.flush(); });
  const configure = () => store.enforcePersonalUniqueness(catalog, 'bot', () => 'home');
  if (enforce) configure();
  const bind = (scopeId: string, nativeId: string, now = 1000, toolId: AgentKind = 'codex', sourceId = 'home') =>
    catalog.upsertActive({ scopeId, agentId: toolId, sourceId, cwdRealpath: dir, policyFingerprint: `p-${nativeId}`,
      botAppId: 'bot', now, ...nativeSessionFields(toolId, nativeId) });
  const legacy = async (bindings: Record<string, ToolBinding>) => {
    await store.flush(); await writeFile(path, JSON.stringify({ version: 1, bindings, archived: [] })); await store.load();
  };
  return { dir, store, catalog, configure, bind, legacy };
}

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('enforces one personal group per %s native session in both stores', async toolId => {
  const h = await fixture(); h.bind('oc_first', 'same', 1, toolId);
  const binding = h.store.get('oc_first')!;
  expect(() => h.store.set('oc_second', binding)).toThrow(PersonalBindingConflict);
  expect(() => h.bind('oc_second', 'same', 2, toolId)).toThrow('oc_first');
  expect(h.store.get('oc_second')).toBeUndefined();
  expect(h.catalog.entries().some(row => row.scopeId === 'oc_second')).toBe(false);
  h.store.set('oc_first', { ...binding, name: 'renamed' }); h.bind('oc_first', 'same', 3, toolId);
  expect(h.store.personalOwner({ toolId, sourceId: 'home', nativeId: 'same' })).toBe('oc_first');
  await Promise.all([h.store.flush(), h.catalog.flush()]);
  const restored = new ToolBindingStore(join(h.dir, 'bindings.json')); await restored.load();
  expect(() => restored.set('oc_second', binding)).toThrow('oc_first');
});

it('keeps tools and data sources independent, including reserved native IDs', async () => {
  const h = await fixture();
  h.store.set('oc_first', { toolId: 'claude', sourceId: 'home', nativeId: 'reserved', nativeCreated: false });
  expect(() => h.store.set('oc_second', { toolId: 'claude', sourceId: 'home', nativeId: 'reserved' })).toThrow('oc_first');
  h.store.set('oc_otherhome', { toolId: 'claude', sourceId: 'other-home', nativeId: 'reserved' });
  h.store.set('oc_othertool', { toolId: 'dsh', sourceId: 'home', nativeId: 'reserved' });
});

it('switches one group to a free session, retires its old live rows and synchronizes the reverse index', async () => {
  const h = await fixture(); h.bind('oc_first', 'old'); h.bind('oc_first', 'new', 2000);
  expect(h.store.get('oc_first')?.nativeId).toBe('new');
  expect(h.catalog.entries().find(row => row.threadId === 'old')?.status).toBe('archived');
  h.bind('oc_second', 'old', 3000);
  expect(() => h.bind('oc_third', 'new', 4000)).toThrow('oc_first');
});

it('ignores closed routes but checks an explicit resume before reopening them', async () => {
  const h = await fixture(); h.bind('oc_first', 'same'); h.catalog.archiveScope('oc_first', 'same');
  h.bind('oc_second', 'same', 2000);
  expect(() => h.catalog.upsertActive({ scopeId: 'oc_first', agentId: 'codex', sourceId: 'home', botAppId: 'bot',
    cwdRealpath: h.dir, policyFingerprint: 'new', threadId: 'same', rebindArchivedScope: true })).toThrow('oc_second');
  expect(h.catalog.isScopeArchived('oc_first')).toBe(true);
  expect(h.catalog.isThreadArchived('same')).toBe(false);
  h.catalog.upsertActive({ scopeId: 'oc_first', agentId: 'codex', sourceId: 'home', botAppId: 'bot',
    cwdRealpath: h.dir, policyFingerprint: 'new', threadId: 'free', rebindArchivedScope: true });
  expect(h.catalog.isScopeArchived('oc_first')).toBe(false);
});

it('retains the oldest legacy personal route and persists retirement without archiving native data', async () => {
  const h = await fixture(false); h.bind('oc_old', 'same', 1); h.bind('oc_new', 'same', 2);
  const binding = { toolId: 'codex' as const, sourceId: 'home', nativeId: 'same', nativeCreated: true };
  await h.legacy({ oc_new: binding, oc_old: binding, oc_aux: { ...binding, auxiliaryWorkgroup: true },
    aux_shared: { ...binding, linkedSource: { toolId: 'codex', sourceId: 'home', nativeId: 'same' } } });
  h.store.linkAuxiliary('oc_open', 'aux_shared');
  h.configure(); h.store.migrate(h.catalog, () => 'home');
  expect(h.catalog.isScopeArchived('oc_new')).toBe(true); expect(h.catalog.isScopeArchived('oc_old')).toBe(false);
  expect(h.catalog.isScopeArchived('oc_aux')).toBe(false); expect(h.catalog.isThreadArchived('same')).toBe(false);
  expect(h.store.personalOwner({ toolId: 'codex', sourceId: 'home', nativeId: 'same' })).toBe('oc_old');
  expect(h.store.settingsScope('oc_open')).toBe('oc_old');
  await h.catalog.flush();
  const restored = new SessionCatalog(join(h.dir, 'catalog.json')); await restored.load();
  expect(restored.isScopeArchived('oc_new')).toBe(true);
  expect(restored.entries().some(row => row.scopeId === 'oc_new' && row.threadId === 'same' && row.status === 'archived')).toBe(true);
});

it('repairs a stale tool ledger from the latest catalog before detecting legacy duplicate owners', async () => {
  const h = await fixture(false); h.bind('oc_old', 'previous', 1); h.bind('oc_old', 'same', 2); h.bind('oc_new', 'same', 3);
  await h.legacy({ oc_old: { toolId: 'codex', sourceId: 'home', nativeId: 'previous', nativeCreated: true } });
  h.configure(); h.store.migrate(h.catalog, () => 'home');
  expect(h.store.get('oc_old')?.nativeId).toBe('same'); expect(h.catalog.isScopeArchived('oc_new')).toBe(true);
  expect(h.catalog.entries().find(row => row.threadId === 'previous')?.status).toBe('archived');
  expect(h.store.personalOwner({ toolId: 'codex', sourceId: 'home', nativeId: 'previous' })).toBeUndefined();
});

it('repairs catalog-only legacy duplicates before migration and does not claim another bot group', async () => {
  const h = await fixture(false); h.bind('oc_old', 'same', 1); h.bind('oc_new', 'same', 2);
  h.catalog.upsertActive({ scopeId: 'oc_foreign', agentId: 'codex', sourceId: 'home', botAppId: 'other-bot',
    cwdRealpath: h.dir, policyFingerprint: 'p', threadId: 'same', now: 0 });
  h.configure(); h.store.migrate(h.catalog, () => 'home');
  expect(h.store.get('oc_old')?.nativeId).toBe('same'); expect(h.store.get('oc_new')).toBeUndefined();
  expect(h.catalog.isScopeArchived('oc_new')).toBe(true); expect(h.catalog.isScopeArchived('oc_foreign')).toBe(false);
});

it('allows auxiliary groups, private collaboration groups, legacy FF groups and API aliases to share the original session', async () => {
  const h = await fixture(); h.bind('oc_owner', 'original');
  const linkedSource = { toolId: 'codex' as const, sourceId: 'home', nativeId: 'original' };
  h.store.set('aux_shared', { ...linkedSource, nativeId: 'original', linkedSource });
  for (const scope of ['oc_open', 'oc_private', 'a2a_request']) {
    h.store.linkAuxiliary(scope, 'aux_shared'); h.bind(scope, 'original');
  }
  h.store.set('oc_oldff', { ...linkedSource, auxiliaryWorkgroup: true }); h.bind('oc_oldff', 'original');
  expect(h.store.settingsScope('oc_open')).toBe('oc_owner');
  expect(h.store.personalOwner(linkedSource)).toBe('oc_owner');
  expect(() => h.bind('oc_secondowner', 'original')).toThrow('oc_owner');
});

it('serializes concurrent creation for one session and releases a failed reservation', async () => {
  const h = await fixture(); const ref = { toolId: 'codex' as const, sourceId: 'home', nativeId: 'one' };
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const create = vi.fn(async (scope: string) => {
    const owner = h.store.personalOwner(ref); if (owner) return owner;
    await wait; h.bind(scope, 'one'); return scope;
  });
  const first = h.store.withPersonalBinding(ref, () => create('oc_first'));
  const second = h.store.withPersonalBinding(ref, () => create('oc_second'));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce()); release();
  expect(await Promise.all([first, second])).toEqual(['oc_first', 'oc_first']);
  const failed = { ...ref, nativeId: 'failed' };
  await expect(h.store.withPersonalBinding(failed, async () => { throw Error('failed create'); })).rejects.toThrow('failed create');
  expect(await h.store.withPersonalBinding(failed, async () => 'retry allowed')).toBe('retry allowed');
});
