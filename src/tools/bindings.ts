import { isToolId, type SessionRef } from './definitions';
import { readFile } from 'node:fs/promises';
import type { AgentKind } from '../config/profile-schema';
import type { SessionCatalog } from '../session/catalog';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

export interface LinkedSession extends SessionRef {
  historyPath?: string;
}

/** A one-time, user-requested history import; unlike linkedSource this is not an FF binding. */
export interface CopiedSessionSource extends SessionRef {
  copyId: string;
  name: string;
  cwd: string;
}

export interface ToolBinding {
  /** Personal owner workgroup for an FF session; never an auxiliary source. */
  auxiliaryWorkgroup?: boolean;
  /** Canonical auxiliary binding; chat aliases retain their own routing scope. */
  sharedScope?: string;
  linkedSource?: LinkedSession;
  copiedFrom?: CopiedSessionSource;
  toolId: AgentKind;
  sourceId: string;
  name?: string;
  nativeId?: string;
  nativeCreated?: boolean;
  model?: string;
  reasoningEffort?: string;
}

export function sessionRefKey(toolId: string, sourceId: string, nativeId: string): string {
  return JSON.stringify([toolId, sourceId, nativeId]);
}

export function isPersonalWorkgroup(scope: string, binding?: Pick<ToolBinding, 'linkedSource' | 'sharedScope' | 'auxiliaryWorkgroup'>): boolean {
  return scope.startsWith('oc_') && !scope.includes(':') && !binding?.linkedSource && !binding?.sharedScope && !binding?.auxiliaryWorkgroup;
}

export class PersonalBindingConflict extends Error {
  constructor(readonly ownerScope: string) { super(`此会话已绑定个人工作群 ${ownerScope}，不能重复绑定。`); }
}

/** Group tool selection survives resets, cwd changes and restarts. */
export class ToolBindingStore {
  private bindings: Record<string, ToolBinding> = {};
  private archived = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
  private catalog?: SessionCatalog;
  private appId?: string;
  private sourceFor?: (id: AgentKind) => string;
  private bindingChains = new Map<string, Promise<unknown>>();
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== 1 || !raw.bindings || !Array.isArray(raw.archived)) throw new Error('Invalid tool binding ledger');
      for (const [scope, b] of Object.entries(raw.bindings)) {
        const value = b as ToolBinding;
        if (!value || !isToolId(value.toolId) || typeof value.sourceId !== 'string') throw new Error('Invalid tool binding');
        if (value.sharedScope !== undefined && (typeof value.sharedScope !== 'string' || !value.sharedScope)) throw new Error('Invalid shared scope');
        if (value.linkedSource && (!isToolId(value.linkedSource.toolId) ||
          ![value.linkedSource.sourceId, value.linkedSource.nativeId].every(v => typeof v === 'string' && v.length > 0) ||
          (value.linkedSource.historyPath !== undefined && (typeof value.linkedSource.historyPath !== 'string' || !value.linkedSource.historyPath)))) throw new Error('Invalid linked source');
        if (value.copiedFrom && (!isToolId(value.copiedFrom.toolId) ||
          ![value.copiedFrom.sourceId, value.copiedFrom.nativeId, value.copiedFrom.copyId, value.copiedFrom.name, value.copiedFrom.cwd]
            .every(v => typeof v === 'string' && v.length > 0))) throw new Error('Invalid copied source');
        this.bindings[scope] = value;
      }
      for (const scope of Object.keys(this.bindings)) this.get(scope); // validate shared aliases before accepting state
      if (!raw.archived.every((k: unknown) => typeof k === 'string')) throw new Error('Invalid tool archives');
      this.archived = new Set(raw.archived);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  entries(): [string, ToolBinding][] { return Object.keys(this.bindings).map(scope => [scope, this.get(scope)!]); }
  get(scope: string): ToolBinding | undefined {
    const b = this.bindings[scope] ?? this.bindings[scope.split(':')[0]!];
    if (!b) return undefined;
    if (!b.sharedScope) return structuredClone(b);
    const shared = this.bindings[b.sharedScope];
    if (!shared || shared.sharedScope || !shared.linkedSource || shared.toolId !== b.toolId || shared.sourceId !== b.sourceId ||
      !b.linkedSource || sessionRefKey(shared.linkedSource.toolId, shared.linkedSource.sourceId, shared.linkedSource.nativeId) !==
      sessionRefKey(b.linkedSource.toolId, b.linkedSource.sourceId, b.linkedSource.nativeId)) throw new Error('Invalid shared auxiliary binding');
    return structuredClone({ ...shared, sharedScope: b.sharedScope });
  }
  /** Raw aliases can retain the old FF ID after only the canonical write committed. */
  legacyNativeSources(): Array<{ toolId: AgentKind; sourceId: string; nativeId: string; source: LinkedSession }> {
    return Object.values(this.bindings).flatMap(b => b.linkedSource && b.nativeId && b.nativeId !== b.linkedSource.nativeId
      ? [{ toolId: b.toolId, sourceId: b.sourceId, nativeId: b.nativeId, source: structuredClone(b.linkedSource) }] : []);
  }
  /** Shared entries follow the unique original workgroup's current model settings. */
  settingsScope(scope: string): string | undefined {
    const binding = this.get(scope);
    if (!binding?.linkedSource && !binding?.auxiliaryWorkgroup) return scope;
    const source = binding.linkedSource ?? binding;
    if (!source.nativeId) return;
    const originals = this.personalBindings().filter(([, b]) =>
      b.toolId === source.toolId && b.sourceId === source.sourceId && b.nativeId === source.nativeId);
    return originals.length === 1 ? originals[0]![0] : undefined;
  }
  set(scope: string, binding: ToolBinding): void {
    const previous = this.get(scope);
    if (previous && (previous.toolId !== binding.toolId || previous.sourceId !== binding.sourceId)) throw new Error('会话创建后不能切换执行工具');
    this.assertPersonalBinding(scope, binding);
    if (binding.sharedScope) {
      const shared = this.get(binding.sharedScope);
      if (!shared?.linkedSource || shared.sharedScope || !binding.linkedSource ||
        sessionRefKey(shared.toolId, shared.sourceId, shared.linkedSource.nativeId) !==
        sessionRefKey(binding.toolId, binding.sourceId, binding.linkedSource.nativeId)) throw new Error('Invalid shared auxiliary binding');
      if (previous?.sharedScope !== binding.sharedScope) throw new Error('共享辅助绑定须通过关联接口建立');
      this.bindings[binding.sharedScope] = { ...binding, sharedScope: undefined };
    }
    this.bindings[scope] = { ...binding };
    this.persist();
  }

  /** All personal group creation paths hold the same lease across remote I/O. */
  async withPersonalBinding<T>(ref: SessionRef, operation: () => Promise<T>): Promise<T> {
    const key = sessionRefKey(ref.toolId, ref.sourceId, ref.nativeId);
    const next = (this.bindingChains.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.bindingChains.set(key, next);
    try { return await next; }
    finally { if (this.bindingChains.get(key) === next) this.bindingChains.delete(key); }
  }

  personalOwner(ref: SessionRef, exceptScope?: string): string | undefined {
    return this.personalBindings().find(([scope, binding]) => scope !== exceptScope &&
      binding.toolId === ref.toolId && binding.sourceId === ref.sourceId && binding.nativeId === ref.nativeId)?.[0];
  }

  assertPersonalBinding(scope: string, binding: ToolBinding): void {
    if (!binding.nativeId || !isPersonalWorkgroup(scope, binding)) return;
    const owner = this.personalOwner({ toolId: binding.toolId, sourceId: binding.sourceId, nativeId: binding.nativeId }, scope);
    if (owner) throw new PersonalBindingConflict(owner);
  }

  /** Upgrade legacy duplicates before any intake/reply observer starts. */
  enforcePersonalUniqueness(catalog: SessionCatalog, appId: string, sourceFor: (id: AgentKind) => string): void {
    this.catalog = catalog; this.appId = appId; this.sourceFor = sourceFor;
    const latest = new Map<string, ReturnType<SessionCatalog['entries']>[number]>();
    for (const row of catalog.entries()) {
      if (row.status !== 'active' || catalog.isScopeArchived(row.scopeId) || (row.botAppId && row.botAppId !== appId) ||
          !isPersonalWorkgroup(row.scopeId, this.get(row.scopeId))) continue;
      const prior = latest.get(row.scopeId);
      if (!prior || (row.boundAt ?? row.updatedAt) >= (prior.boundAt ?? prior.updatedAt)) latest.set(row.scopeId, row);
    }
    for (const [scope, row] of latest) {
      const current = this.get(scope), sourceId = row.sourceId ?? current?.sourceId ?? sourceFor(row.agentId);
      if (current && (current.toolId !== row.agentId || current.sourceId !== sourceId)) continue;
      // A previous resume may have persisted the catalog before updating the tool ledger.
      const nativeId = current?.nativeCreated === false ? current.nativeId : row.threadId ?? row.sessionId;
      if (current && current.nativeCreated !== false && current.nativeId !== nativeId) {
        this.bindings[scope] = { ...current, nativeId, nativeCreated: true }; this.persist();
      }
      for (const old of catalog.entries()) if (old.scopeId === scope && old.status === 'active' &&
          (!old.botAppId || old.botAppId === appId) && (old.threadId ?? old.sessionId) !== nativeId) catalog.archiveActive(old);
    }
    const established = (scope: string) => Math.min(...catalog.entries().filter(row => row.scopeId === scope && row.status === 'active')
      .map(row => row.boundAt ?? row.updatedAt));
    const owners = new Map<string, string>();
    const candidates = this.personalBindings().sort(([a], [b]) => established(a) - established(b) || a.localeCompare(b));
    for (const [scope, binding] of candidates) {
      const key = sessionRefKey(binding.toolId, binding.sourceId, binding.nativeId!);
      const owner = owners.get(key);
      if (!owner) { owners.set(key, scope); continue; }
      // Closing a duplicate bridge route preserves its group, native data and history.
      catalog.archiveScope(scope, binding.nativeId!);
      log.warn('session', 'duplicate-personal-binding-retired', { scope, ownerScope: owner, toolId: binding.toolId });
    }
    catalog.setPersonalBindingGuard(input => {
      const current = this.get(input.scopeId);
      if (!isPersonalWorkgroup(input.scopeId, current)) return false;
      if (input.botAppId && input.botAppId !== appId) return false;
      const binding = { ...current, toolId: input.agentId, sourceId: input.sourceId ?? current?.sourceId ?? sourceFor(input.agentId),
        nativeId: input.threadId ?? input.sessionId };
      if (current && (current.toolId !== binding.toolId || current.sourceId !== binding.sourceId)) throw new Error('会话创建后不能切换执行工具');
      this.assertPersonalBinding(input.scopeId, binding);
      return true;
    }, entry => {
      const current = this.get(entry.scopeId);
      this.set(entry.scopeId, { ...current, toolId: entry.agentId, sourceId: entry.sourceId ?? current?.sourceId ?? sourceFor(entry.agentId),
        nativeId: entry.threadId ?? entry.sessionId, nativeCreated: true });
    });
  }

  private personalBindings(): [string, ToolBinding][] {
    const rows = this.catalog?.entries() ?? [];
    const latest = new Map<string, ReturnType<SessionCatalog['entries']>[number]>();
    for (const row of rows) {
      if (row.status !== 'active' || (row.botAppId && this.appId && row.botAppId !== this.appId)) continue;
      const prior = latest.get(row.scopeId);
      if (!prior || (row.boundAt ?? row.updatedAt) >= (prior.boundAt ?? prior.updatedAt)) latest.set(row.scopeId, row);
    }
    const candidates = new Map(this.entries());
    for (const [scope, row] of latest) if (!candidates.has(scope)) candidates.set(scope, {
      toolId: row.agentId, sourceId: row.sourceId ?? this.sourceFor?.(row.agentId) ?? '', nativeId: row.threadId ?? row.sessionId,
    });
    return [...candidates].filter(([scope, binding]) => {
      if (!binding.nativeId || !isPersonalWorkgroup(scope, binding) || this.catalog?.isScopeArchived(scope) ||
          this.isArchived(binding.toolId, binding.sourceId, binding.nativeId)) return false;
      const scoped = rows.filter(row => row.scopeId === scope);
      // A retired catalog binding cannot retain reverse ownership through a stale ledger.
      if (scoped.length && !scoped.some(row => row.status === 'active' && (!row.botAppId || !this.appId || row.botAppId === this.appId)) && binding.nativeCreated !== false) return false;
      return true;
    });
  }
  linkAuxiliary(scope: string, sharedScope: string): void {
    const shared = this.get(sharedScope);
    if (!shared?.linkedSource || shared.sharedScope || scope === sharedScope) throw new Error('Invalid shared auxiliary target');
    const previous = this.get(scope);
    if (previous && (!previous.linkedSource || previous.toolId !== shared.toolId || previous.sourceId !== shared.sourceId)) throw new Error('不能覆盖个人或其他工具绑定');
    this.bindings[scope] = { ...shared, sharedScope }; this.persist();
  }
  /** A fresh invitation may choose another tool after the previous FF lifecycle ended. */
  releaseAuxiliary(scope: string): void {
    if (!this.bindings[scope]?.linkedSource) throw new Error('不能释放个人会话绑定');
    delete this.bindings[scope]; this.persist();
  }
  hasNativeBinding(toolId: AgentKind, sourceId: string, nativeId: string, knownChats: Set<string>): boolean {
    return this.entries().some(([scope, b]) => knownChats.has(scope.split(':')[0]!) && b.toolId === toolId && b.sourceId === sourceId && b.nativeId === nativeId);
  }
  /** Drop group/topic routes, retaining a canonical entry if live aliases need it. */
  removeChat(chatId: string): void {
    for (const scope of Object.keys(this.bindings)) {
      if (scope !== chatId && !scope.startsWith(`${chatId}:`)) continue;
      if (Object.entries(this.bindings).some(([peer, b]) => peer !== scope && b.sharedScope === scope &&
          peer !== chatId && !peer.startsWith(`${chatId}:`))) continue;
      delete this.bindings[scope];
    }
    this.persist();
  }
  archive(toolId: AgentKind, sourceId: string, nativeId: string): void {
    this.archived.add(sessionRefKey(toolId, sourceId, nativeId)); this.persist();
  }
  isArchived(toolId: AgentKind, sourceId: string, nativeId: string): boolean {
    return this.archived.has(sessionRefKey(toolId, sourceId, nativeId));
  }
  migrate(catalog: SessionCatalog, sourceFor: (id: AgentKind) => string): void {
    const latest = new Map<string, ReturnType<SessionCatalog['entries']>[number]>();
    for (const row of catalog.entries()) {
      if (row.status !== 'active' || catalog.isScopeArchived(row.scopeId) || (row.botAppId && this.appId && row.botAppId !== this.appId)) continue;
      const previous = latest.get(row.scopeId);
      if (previous && previous.agentId !== row.agentId) throw new Error(`工具身份冲突：${row.scopeId}`);
      if (!previous || (row.boundAt ?? row.updatedAt) >= (previous.boundAt ?? previous.updatedAt)) latest.set(row.scopeId, row);
    }
    for (const row of latest.values()) if (!this.get(row.scopeId)) this.set(row.scopeId, {
      toolId: row.agentId, sourceId: row.sourceId ?? sourceFor(row.agentId), nativeId: row.threadId ?? row.sessionId,
    });
  }
  private persist(): void {
    // Snapshot before queuing: do not accidentally persist later mutations under an older operation.
    const snapshot = JSON.stringify({ version: 1, bindings: this.bindings, archived: [...this.archived] }, null, 2);
    this.saving = this.saving.then(() => writeFileAtomic(this.path, `${snapshot}\n`, { mode: 0o600 }));
    void this.saving.catch(() => {}); // flush still propagates the write error.
  }
  async flush(): Promise<void> { await this.saving; }
}
