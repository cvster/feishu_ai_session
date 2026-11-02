import { resolve } from 'node:path';
import type { AgentTool, ToolSession } from '../tools/types';
import { isPersonalWorkgroup, type ToolBindingStore } from '../tools/bindings';
import { nativeSessionFields, type SessionRef } from '../tools/definitions';
import { CURRENT_FINGERPRINT_VERSION, type SessionCatalog, type SessionCatalogEntry } from './catalog';
import { log } from '../core/logger';

/** One scan reopens at most this many routes per tool. */
export const ARCHIVE_RECOVERY_MAX_PER_PASS = 3;
/** More candidates than this means the roster or the ledger is wrong; stop and ask a human. */
export const ARCHIVE_RECOVERY_MAX_CANDIDATES = 10;
/** Guards against a native/bridge ping-pong when a tool reports stale archival state. */
export const ARCHIVE_RECOVERY_COOLDOWN_MS = 30 * 60_000;
const lastReopenedAt = new Map<string, number>();

export interface ArchiveRecoveryDeps {
  catalog: SessionCatalog;
  toolBindings: ToolBindingStore;
  cwdFor?(scope: string): string | undefined;
  isAuxiliary?(scope: string): boolean;
  appId?: string;
  now?(): number;
}

export interface RecoverableRoute extends SessionRef {
  scopeId: string;
  cwdRealpath: string;
  policyFingerprint: string;
  botAppId?: string;
}

/**
 * Only tools whose archive really reaches the native session can prove the user
 * un-archived it. Claude and ZCode archive catalog state only, and Pi deletes
 * the native session instead of archiving it, so `archived === false` says
 * nothing about the user's intent there.
 */
function reversibleArchive(tool: AgentTool): boolean {
  return tool.sessions?.nativeArchive === true && tool.sessions?.archiveEffect !== 'delete';
}

/** Latest catalog row for one scope, ignoring policy revisions of the same route. */
function latestRow(deps: ArchiveRecoveryDeps, scopeId: string): SessionCatalogEntry | undefined {
  return deps.catalog.entries()
    .filter(entry => entry.scopeId === scopeId)
    .sort((a, b) => (b.boundAt ?? b.updatedAt) - (a.boundAt ?? a.updatedAt))[0];
}

/** A row that may be reopened: archived, same session, current policy revision. */
function reopenableRow(deps: ArchiveRecoveryDeps, scopeId: string, route: SessionRef): SessionCatalogEntry | undefined {
  const appId = deps.appId;
  const row = latestRow(deps, scopeId);
  if (!row || row.status !== 'archived' || row.agentId !== route.toolId) return undefined;
  if ((row.threadId ?? row.sessionId) !== route.nativeId) return undefined;
  if (row.sourceId && row.sourceId !== route.sourceId) return undefined;
  if (row.botAppId && appId && row.botAppId !== appId) return undefined;
  // A legacy fingerprint cannot be re-stamped as current without re-evaluating
  // the run policy; those rows wait for an explicit `/resume use`.
  return row.fingerprintVersion === CURRENT_FINGERPRINT_VERSION ? row : undefined;
}

/**
 * Another live route for the same native session. `ToolBindingStore.personalOwner`
 * cannot answer this here: it hides every session in the tool-level archive set,
 * which is exactly the set a candidate still sits in.
 */
function liveOwner(deps: ArchiveRecoveryDeps, route: SessionRef, exceptScope: string): string | undefined {
  const appId = deps.appId;
  for (const [scope, binding] of deps.toolBindings.entries()) {
    if (scope === exceptScope || binding.toolId !== route.toolId || binding.sourceId !== route.sourceId) continue;
    if (binding.nativeId !== route.nativeId || !isPersonalWorkgroup(scope, binding)) continue;
    if (deps.catalog.isScopeArchived(scope) || deps.isAuxiliary?.(scope)) continue;
    const active = deps.catalog.entries().some(row => row.scopeId === scope && row.status === 'active' &&
      row.agentId === route.toolId && (row.threadId ?? row.sessionId) === route.nativeId &&
      (!row.botAppId || !appId || row.botAppId === appId));
    if (active) return scope;
  }
  return undefined;
}

function candidateFor(deps: ArchiveRecoveryDeps, tool: AgentTool, scopeId: string): RecoverableRoute | undefined {
  const binding = deps.toolBindings.get(scopeId);
  if (!binding?.nativeId || binding.toolId !== tool.id || binding.sourceId !== tool.sourceId) return undefined;
  if (!isPersonalWorkgroup(scopeId, binding) || binding.nativeCreated === false) return undefined;
  if (deps.isAuxiliary?.(scopeId)) return undefined;
  const route: SessionRef = { toolId: tool.id, sourceId: binding.sourceId, nativeId: binding.nativeId };
  // The marker records why the route closed. Only a marker holding this native ID
  // came from a native archive; 'dissolved', 'unlinked', 'pending-*' and
  // 'retired:*' markers never qualify.
  if (deps.catalog.scopeArchiveReason(scopeId) !== route.nativeId) return undefined;
  // Two independent proofs that this route closed because of a native archive:
  // the tool-level archive set (retire/dissolve never write it) and a scan that
  // actually saw the native session archived.
  if (!deps.toolBindings.isArchived(route.toolId, binding.sourceId, route.nativeId)) return undefined;
  if (!deps.catalog.observedNativeArchive(route.toolId, binding.sourceId, route.nativeId)) return undefined;
  const row = reopenableRow(deps, scopeId, route);
  if (!row) return undefined;
  const cwd = deps.cwdFor?.(scopeId);
  // A group with no explicit workspace keeps whatever the run policy resolves,
  // so only a recorded workspace can be compared; a changed one blocks recovery.
  if (cwd !== undefined && resolve(cwd) !== resolve(row.cwdRealpath)) return undefined;
  if (liveOwner(deps, route, scopeId)) return undefined;
  return { ...route, scopeId, cwdRealpath: row.cwdRealpath, policyFingerprint: row.policyFingerprint,
    ...(row.botAppId ? { botAppId: row.botAppId } : {}) };
}

/** Routes that may belong to a native session the user un-archived. */
export function recoveryCandidates(deps: ArchiveRecoveryDeps, tool: AgentTool): RecoverableRoute[] {
  if (!reversibleArchive(tool)) return [];
  const routes: RecoverableRoute[] = [];
  for (const scopeId of deps.toolBindings.scopes()) {
    const route = candidateFor(deps, tool, scopeId);
    if (route) routes.push(route);
  }
  // Two closed personal routes for one native session cannot both be reopened;
  // which one the user meant is not knowable from state alone.
  const byNative = new Map<string, RecoverableRoute[]>();
  for (const route of routes) byNative.set(route.nativeId, [...(byNative.get(route.nativeId) ?? []), route]);
  return routes.filter(route => {
    const group = byNative.get(route.nativeId)!;
    if (group.length === 1) return true;
    log.warn('archive-recovery', 'ambiguous-routes', { nativeId: route.nativeId, scopes: group.map(item => item.scopeId) });
    return false;
  });
}

/** Reopen every route whose native session is no longer archived. */
export async function recoverArchivedRoutes(deps: ArchiveRecoveryDeps, tool: AgentTool, rows?: ToolSession[]): Promise<number> {
  if (!reversibleArchive(tool)) return 0;
  const candidates = recoveryCandidates(deps, tool);
  if (!candidates.length) return 0;
  if (candidates.length > ARCHIVE_RECOVERY_MAX_CANDIDATES) {
    log.warn('archive-recovery', 'too-many-candidates', { toolId: tool.id, count: candidates.length });
    return 0;
  }
  const now = deps.now ?? Date.now;
  let roster: ToolSession[];
  if (rows) roster = rows;
  else try { roster = await tool.listSessions(); }
  catch (error) { log.warn('archive-recovery', 'list-failed', { toolId: tool.id, error: String(error) }); return 0; }
  let reopened = 0;
  for (const route of candidates) {
    if (reopened >= ARCHIVE_RECOVERY_MAX_PER_PASS) break;
    const last = lastReopenedAt.get(route.scopeId);
    if (last !== undefined && now() - last < ARCHIVE_RECOVERY_COOLDOWN_MS) continue;
    const current = roster.find(item => item.nativeId === route.nativeId);
    // `archived` must be an explicit false: an absent flag is not evidence.
    if (!current || current.archived !== false || resolve(current.cwd) !== resolve(route.cwdRealpath)) continue;
    try {
      const done = await deps.toolBindings.withPersonalBinding(route, async () => {
        // Anything may have changed while the roster was in flight, including an
        // explicit `/resume use` to another session; re-check under the lock.
        if (deps.catalog.scopeArchiveReason(route.scopeId) !== route.nativeId) return false;
        if (deps.toolBindings.get(route.scopeId)?.nativeId !== route.nativeId) return false;
        if (!reopenableRow(deps, route.scopeId, route)) return false;
        if (liveOwner(deps, route, route.scopeId)) return false;
        const topics: SessionCatalogEntry[] = [];
        // Topic routes live only in the catalog; they share the chat's prefix.
        for (const scope of new Set(deps.catalog.entries().map(entry => entry.scopeId))) {
          if (!scope.startsWith(`${route.scopeId}:`)) continue;
          if (deps.catalog.scopeArchiveReason(scope) !== route.nativeId) continue;
          const topic = reopenableRow(deps, scope, route);
          if (topic) topics.push(topic);
        }
        // Clears the codex thread tombstone; otherwise the upsert below is rejected.
        deps.catalog.unarchiveThread(route.nativeId);
        deps.catalog.upsertActive({ scopeId: route.scopeId, agentId: route.toolId, sourceId: route.sourceId,
          cwdRealpath: route.cwdRealpath, policyFingerprint: route.policyFingerprint,
          ...(route.botAppId ? { botAppId: route.botAppId } : {}), ...nativeSessionFields(route.toolId, route.nativeId),
          rebindArchivedScope: true, now: now() });
        // Topic routes closed by the same archival reopen only when their own row
        // still records this native session and the current policy revision.
        for (const topic of topics) deps.catalog.upsertActive({ scopeId: topic.scopeId, agentId: topic.agentId,
          ...(topic.sourceId ? { sourceId: topic.sourceId } : {}), cwdRealpath: topic.cwdRealpath,
          policyFingerprint: topic.policyFingerprint, ...(topic.botAppId ? { botAppId: topic.botAppId } : {}),
          ...nativeSessionFields(topic.agentId, route.nativeId), rebindArchivedScope: true, now: now() });
        deps.toolBindings.unarchive(route.toolId, route.sourceId, route.nativeId);
        deps.catalog.clearNativeArchive(route.toolId, route.sourceId, route.nativeId);
        await Promise.all([deps.catalog.flush(), deps.toolBindings.flush()]);
        return true;
      });
      if (!done) continue;
      lastReopenedAt.set(route.scopeId, now());
      reopened += 1;
      log.info('archive-recovery', 'route-reopened', {
        scopeId: route.scopeId, toolId: route.toolId, nativeId: route.nativeId, cwd: route.cwdRealpath,
      });
    } catch (error) {
      log.warn('archive-recovery', 'reopen-failed', { scopeId: route.scopeId, toolId: route.toolId, error: String(error) });
    }
  }
  return reopened;
}

/** Test seam: cool-down state is process-local by design. */
export function resetArchiveRecoveryState(): void { lastReopenedAt.clear(); }
