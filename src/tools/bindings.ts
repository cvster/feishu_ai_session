import { isToolId, type SessionRef } from './definitions';
import { readFile } from 'node:fs/promises';
import type { AgentKind } from '../config/profile-schema';
import type { SessionCatalog } from '../session/catalog';
import { writeFileAtomic } from '../platform/atomic-write';

export interface LinkedSession extends SessionRef {
  historyPath: string;
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

/** Group tool selection survives resets, cwd changes and restarts. */
export class ToolBindingStore {
  private bindings: Record<string, ToolBinding> = {};
  private archived = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
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
          ![value.linkedSource.sourceId, value.linkedSource.nativeId, value.linkedSource.historyPath].every(v => typeof v === 'string' && v.length > 0))) throw new Error('Invalid linked source');
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
  set(scope: string, binding: ToolBinding): void {
    const previous = this.get(scope);
    if (previous && (previous.toolId !== binding.toolId || previous.sourceId !== binding.sourceId)) throw new Error('会话创建后不能切换执行工具');
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
  archive(toolId: AgentKind, sourceId: string, nativeId: string): void {
    this.archived.add(sessionRefKey(toolId, sourceId, nativeId)); this.persist();
  }
  isArchived(toolId: AgentKind, sourceId: string, nativeId: string): boolean {
    return this.archived.has(sessionRefKey(toolId, sourceId, nativeId));
  }
  migrate(catalog: SessionCatalog, sourceFor: (id: AgentKind) => string): void {
    const latest = new Map<string, ReturnType<SessionCatalog['entries']>[number]>();
    for (const row of catalog.entries()) {
      if (row.status !== 'active') continue;
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
