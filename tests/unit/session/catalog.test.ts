import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  it('backs up and migrates unordered duplicate legacy routes to one current entry without losing history or replay epochs', async () => {
    const file = await path();
    const old = { ...entry('oc_group', 'native', 10, 'old-policy'), boundAt: 1, fingerprintVersion: 3, recentTurnReplayCount: 3 };
    const latest = { ...old, key: sessionCatalogKey({ ...old, policyFingerprint: 'new-policy' }), policyFingerprint: 'new-policy', updatedAt: 20, sourceId: 'source', recentTurnReplayCount: undefined };
    await writeFile(file, JSON.stringify([latest, old]));
    const catalog = new SessionCatalog(file); await catalog.load();
    expect(catalog.entries().filter(r => r.status === 'active')).toEqual([latest]);
    expect(catalog.entries().find(r => r.policyFingerprint === 'old-policy')?.status).toBe('archived');
    expect(JSON.parse(await readFile(file + '.v1-backup', 'utf8'))).toEqual(JSON.parse(JSON.stringify([latest, old])));
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.version).toBe(2); expect(Object.keys(stored.current)).toEqual(['oc_group']); expect(stored.history).toHaveLength(1);
    const restarted = new SessionCatalog(file); await restarted.load();
    expect(restarted.activeFor(latest)).toMatchObject({ boundAt: 1, sourceId: 'source' });
    expect(restarted.activeFor(old)).toBeUndefined();
  });

  it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('structurally replaces %s personal and shared routes across policies and retains same-policy session history', async tool => {
    const file = await path(), catalog = new SessionCatalog(file);
    for (const scopeId of ['oc_personal', 'oc_shared', 'oc_shared:topic']) {
      const base = { scopeId, agentId: tool, cwdRealpath: '/repo', policyFingerprint: 'p1', sourceId: 'home', botAppId: 'bot' };
      const fields = (id: string) => tool === 'codex' ? { threadId: id } : { sessionId: id };
      catalog.upsertActive({ ...base, ...fields('old'), now: 1 });
      catalog.upsertActive({ ...base, ...fields('new'), now: 2 });
      catalog.upsertActive({ ...base, policyFingerprint: 'p2', ...fields('new'), preserveBinding: true, now: 3 });
      expect(catalog.entries().filter(r => r.scopeId === scopeId && r.status === 'active')).toHaveLength(1);
      expect(catalog.entries().filter(r => r.scopeId === scopeId && r.status === 'archived')).toHaveLength(2);
      expect(catalog.activeFor(base)).toBeUndefined();
    }
    await catalog.flush(); const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(stored.current)).toHaveLength(3); expect(stored.history.every((r: any) => r.status === 'archived')).toBe(true);
    const loaded = new SessionCatalog(file); await loaded.load();
    expect(loaded.entries().filter(r => r.status === 'active')).toHaveLength(3);
    if (tool === 'codex') { loaded.archiveCodexThread('old'); expect(loaded.entries().filter(r => r.status === 'active')).toHaveLength(3); }
    await loaded.flush();
  });

  it('never discards current routes when history limits are smaller than the live scope count', async () => {
    const file = await path(), catalog = new SessionCatalog(file);
    for (const scope of ['oc_a', 'oc_b']) {
      catalog.upsertActive({ ...entry(scope, 'old', 1) });
      catalog.upsertActive({ ...entry(scope, 'new', 2) });
    }
    catalog.gc({ now: 3, maxEntriesPerScope: 0, maxEntriesPerProfile: 0 });
    await catalog.flush();
    const restored = new SessionCatalog(file); await restored.load();
    expect(restored.entries()).toHaveLength(2);
    expect(restored.entries().every(row => row.status === 'active' && row.sessionId === 'new')).toBe(true);
  });

  it('removes a legacy association and its topics without archiving native data or marking the group dissolved', async () => {
    const file = await path(), catalog = new SessionCatalog(file);
    const base = { agentId: 'kilo' as const, cwdRealpath: '/repo', policyFingerprint: 'p', sourceId: 'home', botAppId: 'bot', sessionId: 'old' };
    catalog.upsertActive({ ...base, scopeId: 'oc_legacy', now: 1 });
    catalog.upsertActive({ ...base, scopeId: 'oc_legacy:topic', now: 1 });
    catalog.upsertActive({ ...base, scopeId: 'oc_keep', sessionId: 'keep', now: 1 });
    catalog.unlinkChat('oc_legacy', [{ agentId: 'kilo', sourceId: 'home', nativeId: 'old' }]); await catalog.flush();
    const loaded = new SessionCatalog(file); await loaded.load();
    expect(loaded.entries().map(r => r.scopeId)).toEqual(['oc_keep']);
    expect(loaded.isScopeArchived('oc_legacy')).toBe(true); expect(loaded.isScopeArchived('oc_legacy:topic')).toBe(true);
    expect(loaded.isAutoGroupSuppressed('kilo', 'home', 'old')).toBe(true);
    expect(loaded.isChatDissolved('oc_legacy')).toBe(false); expect(loaded.isThreadArchived('old')).toBe(false);
    expect(loaded.pendingArchiveNotifications()).toHaveLength(0);
  });

  it('rejects a current record stored under another scope and active history rows', async () => {
    const file = await path(), row = entry('oc_group', 'native', 1);
    await writeFile(file, JSON.stringify({ version: 2, current: { oc_other: row }, history: [] }));
    await expect(new SessionCatalog(file).load()).rejects.toThrow('Invalid current');
    await writeFile(file, JSON.stringify({ version: 2, current: {}, history: [row] }));
    await expect(new SessionCatalog(file).load()).rejects.toThrow('Invalid catalog history');
  });
  it('keeps true archive tombstones across GC/restart and only clears the group on explicit rebinding', async () => {
    const file = await path();
    const catalog = new SessionCatalog(file);
    const identity = { scopeId: 'oc_archived', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'fp' };
    catalog.upsertActive({ ...identity, threadId: 'old', now: 1 });
    catalog.archiveCodexThread('old', 2);
    catalog.gc({ now: 1_000_000, maxArchivedAgeMs: 1, maxEntriesPerProfile: 0 });
    await catalog.flush();
    const loaded = new SessionCatalog(file); await loaded.load();
    expect(loaded.isScopeArchived('oc_archived')).toBe(true);
    expect(loaded.isThreadArchived('old')).toBe(true);
    expect(() => loaded.upsertActive({ ...identity, threadId: 'old' })).toThrow('已归档');
    expect(() => loaded.upsertActive({ ...identity, threadId: 'new' })).toThrow('已归档');
    loaded.upsertActive({ ...identity, threadId: 'new', rebindArchivedScope: true });
    expect(loaded.isScopeArchived('oc_archived')).toBe(false);
    expect(loaded.isThreadArchived('old')).toBe(true);
    expect(loaded.activeFor(identity)?.threadId).toBe('new');
    await loaded.flush();
  });

  it('does not close a group when retiring a binding or archiving an older thread', async () => {
    const catalog = new SessionCatalog(await path());
    const identity = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'fp' };
    catalog.upsertActive({ ...identity, threadId: 'old', now: 1 });
    catalog.archiveActive(identity);
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    catalog.upsertActive({ ...identity, policyFingerprint: 'fp2', threadId: 'new', now: Date.now() + 1 });
    catalog.archiveCodexThread('old');
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    await catalog.flush();
  });

  it.each([false, true])('closes the actual current binding even when an older archive has a newer timestamp (same time: %s)', async (sameTime) => {
    const catalog = new SessionCatalog(await path());
    const identity = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'old' };
    catalog.upsertActive({ ...identity, threadId: 'older', now: 1 });
    catalog.upsertActive({ ...identity, policyFingerprint: 'current', threadId: 'current', now: sameTime ? 1 : 2 });
    catalog.archiveCodexThread('older', 3);
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    catalog.archiveCodexThread('current', 4);
    expect(catalog.isScopeArchived('oc_group')).toBe(true);
    await catalog.flush();
  });

  it('surfaces archive-ledger persistence failure instead of claiming durable success', async () => {
    const file = await path(); const catalog = new SessionCatalog(file);
    catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', cwdRealpath: '/repo', policyFingerprint: 'p', threadId: 'thread' });
    await catalog.flush();
    await rm(`${file}.archives.json`); await mkdir(`${file}.archives.json`);
    catalog.archiveCodexThread('thread');
    await expect(catalog.flush()).rejects.toBeDefined();
    expect(catalog.isScopeArchived('oc_group')).toBe(true);
  });

  it('retires other stale active bindings in a group when its current thread is archived', async () => {
    const catalog = new SessionCatalog(await path());
    const base = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo' };
    catalog.upsertActive({ ...base, policyFingerprint: 'old', threadId: 'old', now: 1 });
    catalog.upsertActive({ ...base, policyFingerprint: 'new', threadId: 'new', now: 2 });
    catalog.archiveCodexThread('new', 3);
    expect(catalog.entries().every((e) => e.status === 'archived')).toBe(true);
    expect(catalog.isThreadArchived('old')).toBe(false);
    await catalog.flush();
  });

  it('uses the last established binding when an existing key is reused within the same millisecond', async () => {
    const catalog = new SessionCatalog(await path());
    const base = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo' };
    catalog.upsertActive({ ...base, policyFingerprint: 'fp1', threadId: 'first', now: 1 });
    catalog.upsertActive({ ...base, policyFingerprint: 'fp2', threadId: 'second', now: 2 });
    catalog.upsertActive({ ...base, policyFingerprint: 'fp1', threadId: 'current', now: 2 });
    catalog.archiveCodexThread('current', 3);
    expect(catalog.isScopeArchived('oc_group')).toBe(true); await catalog.flush();
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('keeps one current route per scope when the tool changes, retaining the previous tool in history', async () => {
    const catalog = new SessionCatalog(await path());

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    expect(catalog.entries().find(e => e.sessionId === 'sess-1')).toMatchObject({ status: 'archived' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ threadId: 'thread-1', agentId: 'codex' });
    await catalog.flush();
  });

  it('persists the Feishu bot app that established a binding', async () => {
    const catalogPath = await path();
    const catalog = new SessionCatalog(catalogPath);
    const identity = {
      scopeId: 'chat-1',
      agentId: 'codex' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };

    catalog.upsertActive({
      ...identity,
      threadId: 'thread-1',
      botAppId: 'cli_current',
    });
    await catalog.flush();

    const reloaded = new SessionCatalog(catalogPath);
    await reloaded.load();
    expect(reloaded.activeFor(identity)).toMatchObject({
      threadId: 'thread-1',
      botAppId: 'cli_current',
    });
  });

  it('consumes a creation-time replay marker and allows an explicit clear on rebinding', async () => {
    const catalog = new SessionCatalog(await path());
    const identity = {
      scopeId: 'chat-replay',
      agentId: 'codex' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-replay',
    };
    catalog.upsertActive({
      ...identity,
      threadId: 'thread-1',
      recentTurnReplayCount: 3,
    });
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBe(3);
    expect(catalog.clearRecentTurnReplay('chat-replay', 'thread-1')).toBe(1);
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBeUndefined();

    catalog.upsertActive({
      ...identity,
      threadId: 'thread-2',
      recentTurnReplayCount: 3,
    });
    catalog.upsertActive({
      ...identity,
      threadId: 'thread-2',
      recentTurnReplayCount: null,
    });
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBeUndefined();
    await catalog.flush();
  });

  it('keeps the binding epoch and consumed replay marker across system updates, policy changes and restart', async () => {
    const file = await path(), catalog = new SessionCatalog(file);
    const identity = { scopeId: 'oc_group', agentId: 'kilo' as const, cwdRealpath: '/repo', policyFingerprint: 'fp',
      sessionId: 'native', sourceId: 'source', botAppId: 'cli_test' };
    catalog.upsertActive({ ...identity, now: 1000, recentTurnReplayCount: 3 });
    expect(catalog.clearRecentTurnReplay('oc_group', 'native', 'kilo', 'source')).toBe(1);
    expect(catalog.upsertActive({ ...identity, preserveBinding: true, now: 2000 })).toMatchObject({ boundAt: 1000, updatedAt: 2000 });
    const next = catalog.upsertActive({ ...identity, policyFingerprint: 'fp-next', preserveBinding: true, now: 3000 });
    expect(next.boundAt).toBe(1000); expect(next.recentTurnReplayCount).toBeUndefined();
    await catalog.flush();
    const loaded = new SessionCatalog(file); await loaded.load();
    expect(loaded.activeFor(next)).toMatchObject({ boundAt: 1000, sourceId: 'source', botAppId: 'cli_test' });
    expect(loaded.upsertActive({ ...identity, policyFingerprint: 'fp-next', now: 4000 }).boundAt).toBe(4000);
    expect(loaded.upsertActive({ ...identity, sessionId: 'other', preserveBinding: true, now: 5000 }).boundAt).toBe(5000);
    expect(loaded.upsertActive({ ...identity, sessionId: 'other', sourceId: 'other-source', preserveBinding: true, now: 6000 }).boundAt).toBe(6000);
    await loaded.flush();
  });

  it('rejects mismatched Claude/Codex identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/Claude.*sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-wrong',
        now: 1000,
      }),
    ).toThrow(/Codex.*threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('does not let an archive of an older tool revision close the current route', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', sessionId: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(false);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('migrates the newest legacy fingerprint once without weakening future policy changes', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      entry('chat-1', 'sess-old', 1000, 'legacy-fp-1'),
      entry('chat-1', 'sess-newest', 2000, 'legacy-fp-2'),
    ]);

    const migratedIdentity = {
      scopeId: 'chat-1',
      agentId: 'claude' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'v3-fp',
    };
    expect(catalog.activeFor(migratedIdentity)).toMatchObject({
      sessionId: 'sess-newest',
      fingerprintVersion: 3,
      policyFingerprint: 'v3-fp',
    });
    expect(catalog.entries().filter((item) => item.status === 'archived')).toHaveLength(2);
    expect(
      catalog.activeFor({ ...migratedIdentity, policyFingerprint: 'future-policy-change' }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    const now = 100 * 24 * 60 * 60 * 1000;
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, now - 1000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, now - 2000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(19);
    expect(catalog.entries().filter((item) => item.status === 'active')).toHaveLength(982);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}
