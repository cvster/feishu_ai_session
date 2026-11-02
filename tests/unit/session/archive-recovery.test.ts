import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { nativeSessionFields } from '../../../src/tools/definitions';
import type { ToolSession } from '../../../src/tools/types';
import { ARCHIVE_RECOVERY_MAX_PER_PASS, recoverArchivedRoutes, resetArchiveRecoveryState, recoveryCandidates } from '../../../src/session/archive-recovery';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
beforeEach(() => resetArchiveRecoveryState());

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'archive-recovery-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new ToolBindingStore(join(dir, 'bindings.json')), catalog = new SessionCatalog(join(dir, 'catalog.json'));
  await store.load(); await catalog.load();
  cleanups.push(async () => { await store.flush(); await catalog.flush(); });
  store.enforcePersonalUniqueness(catalog, 'bot', () => 'home');
  const bind = (scopeId: string, nativeId: string, now = 1000) => {
    catalog.upsertActive({ scopeId, agentId: 'codex', sourceId: 'home', cwdRealpath: dir, policyFingerprint: `p-${nativeId}`,
      botAppId: 'bot', now, ...nativeSessionFields('codex', nativeId) });
    store.set(scopeId, { toolId: 'codex', sourceId: 'home', nativeId, nativeCreated: true });
  };
  /** The bridge closes the route the way a native archival does, and a scan saw it. */
  const archive = (scopeId: string, nativeId: string, observed = true) => {
    catalog.archiveScope(scopeId, nativeId);
    store.archive('codex', 'home', nativeId);
    if (observed) catalog.noteNativeArchive('codex', 'home', nativeId);
  };
  const topic = (scopeId: string, nativeId: string, now = 1100) => catalog.upsertActive({ scopeId, agentId: 'codex',
    sourceId: 'home', cwdRealpath: dir, policyFingerprint: `p-${nativeId}`, botAppId: 'bot', now, ...nativeSessionFields('codex', nativeId) });
  const tool = (rows: ToolSession[], sessions: { nativeArchive?: boolean; archiveEffect?: 'delete' } = { nativeArchive: true }) => ({
    id: 'codex' as const, sourceId: 'home', label: 'Codex',
    agent: {} as never,
    sessions: { nativeArchive: sessions.nativeArchive, archiveEffect: sessions.archiveEffect,
      historyPointer: async () => undefined, rename: async () => {}, archive: async () => {} } as never,
    listSessions: async () => { throw new Error('recovery must reuse the scan roster'); },
  });
  const deps = { catalog, toolBindings: store, appId: 'bot', cwdFor: () => dir };
  return { dir, store, catalog, bind, archive, topic, tool, deps };
}
const row = (dir: string, nativeId = 'n1', archived: boolean | 'absent' = false): ToolSession =>
  ({ nativeId, cwd: dir, createdAtMs: 1, updatedAtMs: 2, ...(archived === 'absent' ? {} : { archived }) });

it('reopens a route whose native session the user un-archived', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(1);
  expect(h.catalog.isScopeArchived('oc_group')).toBe(false);
  expect(h.store.isArchived('codex', 'home', 'n1')).toBe(false);
  const active = h.catalog.entries().find(entry => entry.scopeId === 'oc_group' && entry.status === 'active');
  expect(active?.threadId).toBe('n1');
  expect(active?.policyFingerprint).toBe('p-n1');
  // Reload from disk: the reopened state must survive a restart.
  await Promise.all([h.catalog.flush(), h.store.flush()]);
  const catalog = new SessionCatalog(join(h.dir, 'catalog.json')), store = new ToolBindingStore(join(h.dir, 'bindings.json'));
  await Promise.all([catalog.load(), store.load()]);
  expect(catalog.isScopeArchived('oc_group')).toBe(false);
  expect(store.isArchived('codex', 'home', 'n1')).toBe(false);
  expect(catalog.observedNativeArchive('codex', 'home', 'n1')).toBe(false);
});

it('leaves an archived native session closed', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir, 'n1', true)])).toBe(0);
  expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
  expect(h.store.isArchived('codex', 'home', 'n1')).toBe(true);
});

it('treats a missing archived flag as unknown, not as un-archived', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir, 'n1', 'absent')])).toBe(0);
  expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
});

it('never recovers tools whose archive is catalog-only or destructive', async () => {
  for (const sessions of [{ nativeArchive: false }, { nativeArchive: true, archiveEffect: 'delete' as const }]) {
    resetArchiveRecoveryState();
    const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
    expect(await recoverArchivedRoutes(h.deps, h.tool([], sessions), [row(h.dir)])).toBe(0);
    expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
  }
});

it('needs both the tool-level archive set and an observed native archive', async () => {
  const unobserved = await fixture(); unobserved.bind('oc_group', 'n1'); unobserved.archive('oc_group', 'n1', false);
  expect(recoveryCandidates(unobserved.deps, unobserved.tool([]))).toEqual([]);

  const retired = await fixture(); retired.bind('oc_group', 'n1'); retired.archive('oc_group', 'n1');
  retired.store.unarchive('codex', 'home', 'n1');
  expect(recoveryCandidates(retired.deps, retired.tool([]))).toEqual([]);

  const legacyMarker = await fixture(); legacyMarker.bind('oc_group', 'n1'); legacyMarker.archive('oc_group', 'n1');
  legacyMarker.catalog.archiveScope('oc_group', 'retired:n1');
  expect(recoveryCandidates(legacyMarker.deps, legacyMarker.tool([]))).toEqual([]);
});

it('skips a dissolved group', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  h.catalog.markChatDissolved('oc_group', [{ agentId: 'codex', sourceId: 'home', nativeId: 'n1' }]);
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(0);
});

it('skips a session another live route still owns', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  // A live owner appears while the tool-level set still hides it from personalOwner.
  h.catalog.upsertActive({ scopeId: 'oc_other', agentId: 'codex', sourceId: 'home', cwdRealpath: h.dir,
    policyFingerprint: 'p-n1', botAppId: 'bot', now: 5000, ...nativeSessionFields('codex', 'n1') });
  h.store.set('oc_other', { toolId: 'codex', sourceId: 'home', nativeId: 'n1', nativeCreated: true });
  expect(h.store.isArchived('codex', 'home', 'n1')).toBe(true);
  expect(recoveryCandidates(h.deps, h.tool([]))).toEqual([]);
});

it('skips auxiliary routes and a changed workspace', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  h.store.set('oc_group', { ...h.store.get('oc_group')!, linkedSource: { toolId: 'codex', sourceId: 'home', nativeId: 'n0' } });
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(0);

  const cwd = await fixture(); cwd.bind('oc_group', 'n1'); cwd.archive('oc_group', 'n1');
  expect(await recoverArchivedRoutes(cwd.deps, cwd.tool([]), [row('/elsewhere')])).toBe(0);
  expect(cwd.catalog.isScopeArchived('oc_group')).toBe(true);
  expect(await recoverArchivedRoutes({ ...cwd.deps, cwdFor: () => '/somewhere-else' }, cwd.tool([]), [row(cwd.dir)])).toBe(0);
});

it('clears the codex thread marker so resume and run-flow stop blocking', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  h.catalog.archiveCodexThread('n1');
  expect(h.catalog.isThreadArchived('n1')).toBe(true);
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(1);
  expect(h.catalog.isThreadArchived('n1')).toBe(false);
});

it('reopens topic routes closed by the same archival, but not one bound elsewhere', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1');
  h.topic('oc_group:topic', 'n1'); h.topic('oc_group:other', 'n9');
  h.archive('oc_group', 'n1');
  h.catalog.archiveScope('oc_group:topic', 'n1'); h.catalog.archiveScope('oc_group:other', 'n1');
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(1);
  expect(h.catalog.isScopeArchived('oc_group:topic')).toBe(false);
  expect(h.catalog.entries().some(entry => entry.scopeId === 'oc_group:topic' && entry.status === 'active')).toBe(true);
  expect(h.catalog.isScopeArchived('oc_group:other')).toBe(true);
  expect(h.catalog.entries().some(entry => entry.scopeId === 'oc_group:other' && entry.status === 'active')).toBe(false);
});

it('skips a native session with two closed personal routes', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  // A second group was resumed onto the same native session before it was archived.
  h.catalog.upsertActive({ scopeId: 'oc_second', agentId: 'codex', sourceId: 'home', cwdRealpath: h.dir,
    policyFingerprint: 'p-n1', botAppId: 'bot', now: 1200, ...nativeSessionFields('codex', 'n1') });
  h.store.set('oc_second', { toolId: 'codex', sourceId: 'home', nativeId: 'n1', nativeCreated: true });
  h.catalog.archiveScope('oc_second', 'n1');
  expect(recoveryCandidates(h.deps, h.tool([]))).toEqual([]);
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(0);
  expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
  expect(h.catalog.isScopeArchived('oc_second')).toBe(true);
});

it('stops before touching a roster that looks implausible', async () => {
  const h = await fixture();
  for (let index = 0; index < 11; index++) {
    const nativeId = `n${index}`;
    h.bind(`oc_group${index}`, nativeId);
    h.catalog.upsertActive({ scopeId: `oc_group${index}`, agentId: 'codex', sourceId: 'home', cwdRealpath: h.dir,
      policyFingerprint: `p-${nativeId}`, botAppId: 'bot', now: 2000 + index, ...nativeSessionFields('codex', nativeId) });
    h.archive(`oc_group${index}`, nativeId);
  }
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [])).toBe(0);
  expect(h.catalog.isScopeArchived('oc_group0')).toBe(true);
});

it(`reopens at most ${ARCHIVE_RECOVERY_MAX_PER_PASS} routes per scan`, async () => {
  const h = await fixture();
  for (let index = 0; index < 4; index++) {
    const nativeId = `n${index}`;
    h.bind(`oc_group${index}`, nativeId);
    h.catalog.upsertActive({ scopeId: `oc_group${index}`, agentId: 'codex', sourceId: 'home', cwdRealpath: h.dir,
      policyFingerprint: `p-${nativeId}`, botAppId: 'bot', now: 2000 + index, ...nativeSessionFields('codex', nativeId) });
    h.archive(`oc_group${index}`, nativeId);
  }
  const rows = [0, 1, 2, 3].map(index => row(h.dir, `n${index}`));
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), rows)).toBe(ARCHIVE_RECOVERY_MAX_PER_PASS);
});

it('does not reopen the same route twice within the cool-down window', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(1);
  h.catalog.archiveScope('oc_group', 'n1');
  h.store.archive('codex', 'home', 'n1');
  h.catalog.noteNativeArchive('codex', 'home', 'n1');
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), [row(h.dir)])).toBe(0);
});

it('does not reopen a route that was re-pointed to another session', async () => {
  const h = await fixture(); h.bind('oc_group', 'n1'); h.archive('oc_group', 'n1');
  const roster = [row(h.dir)];
  // An explicit resume lands between candidate selection and the roster check.
  h.catalog.reopenScope('oc_group');
  h.catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', sourceId: 'home', cwdRealpath: h.dir,
    policyFingerprint: 'p-n2', botAppId: 'bot', now: 9000, ...nativeSessionFields('codex', 'n2') });
  h.store.set('oc_group', { toolId: 'codex', sourceId: 'home', nativeId: 'n2', nativeCreated: true });
  expect(await recoverArchivedRoutes(h.deps, h.tool([]), roster)).toBe(0);
  expect(h.store.get('oc_group')?.nativeId).toBe('n2');
});
