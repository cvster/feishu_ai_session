import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionCatalogEntry, CatalogAgentId } from '../session/catalog';
import { renameChat } from './group';
import type { KnownChat } from './lark-info';

export const NAME_SYNC_INTERVAL_MS = 15_000;

interface NameState {
  groupName: string;
  threadName: string;
  /** Ignore an old snapshot until our own write has been observed. */
  previousGroupName?: string;
  previousThreadName?: string;
  /** A confirmed Web/group rename still needs its native acknowledgement. */
  pendingSessionRename?: boolean;
}

export interface CodexNameSyncOptions {
  channel: LarkChannel;
  agent: Pick<AgentAdapter, 'setThreadName'>;
  appId: string;
  statePath: string;
  knownChats?: () => KnownChat[];
  now?: () => number;
}

export interface SessionNameSyncOptions extends Omit<CodexNameSyncOptions, 'agent'> {
  toolId: CatalogAgentId;
  sourceId?: string;
  /** A worker poller can supply zero when its own timer controls chat lookups. */
  chatCheckIntervalMs?: number;
  renameSession?(id: string, name: string): Promise<void>;
  onSynchronized?(scope: string, id: string, name: string): Promise<void>;
}
export interface NamedSessionSnapshot { id: string; name?: string }

/** Reuses native snapshot polling without creating a task or sending a prompt. */
export class SessionNameSync {
  private readonly states = new Map<string, NameState>();
  private readonly nextCheck = new Map<string, number>();
  private readonly modes = new Map<string, string>();
  private readonly retryAfter = new Map<string, number>();
  private dirty = false;
  private operations: Promise<unknown> = Promise.resolve();
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.operations.catch(() => {}).then(action); this.operations = task; return task;
  }

  constructor(private readonly options: SessionNameSyncOptions) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.options.statePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.bindings)) throw new Error('Invalid name sync state');
      for (const [key, state] of data.bindings) {
        if (typeof key !== 'string' || !state || typeof state.groupName !== 'string' ||
          typeof state.threadName !== 'string') throw new Error('Invalid name sync binding');
        this.states.set(key, state);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  observe<T extends NamedSessionSnapshot>(snapshot: T, entries: SessionCatalogEntry[], isActive: (scope: string) => boolean = () => true): Promise<void> {
    return this.serialize(() => this.observeNow(snapshot, entries, isActive));
  }

  /** Explicit Web rename and periodic observations share a serialized baseline. */
  rename(chatId: string, snapshot: NamedSessionSnapshot, name: string, isActive: () => boolean): Promise<{ pendingSync: boolean }> {
    return this.serialize(async () => {
      if (!this.options.renameSession || !isActive()) throw new Error('会话绑定已失效');
      if (await this.options.channel.getChatMode(chatId) !== 'group') throw new Error('仅支持个人 AI 会话群');
      const oldGroup = (await this.options.channel.getChatInfo(chatId)).name?.trim() ?? '';
      if (!isActive()) throw new Error('会话绑定已变化');
      const key = this.stateKey(chatId, snapshot.id);
      // The group is the durable request, just as when renamed in Feishu.
      // Do not modify the native title if Feishu rejects the group write.
      await this.save(key, { groupName: oldGroup, threadName: snapshot.name?.trim() ?? '' });
      await renameChat(this.options.channel, chatId, name);
      await this.save(key, { groupName: name, threadName: snapshot.name?.trim() ?? '', previousGroupName: oldGroup, pendingSessionRename: true });
      let pendingSync = false;
      try {
        if (!isActive()) throw new Error('会话绑定已变化');
        if (snapshot.name?.trim() !== name) await this.options.renameSession(snapshot.id, name);
        await this.save(key, { groupName: name, threadName: name, previousGroupName: oldGroup, previousThreadName: snapshot.name?.trim() ?? '' });
      } catch (err) {
        pendingSync = true;
        log.warn('session', 'web-name-sync-pending', { chatId, threadId: snapshot.id, err: err instanceof Error ? err.message : String(err) });
      }
      if (!isActive()) throw new Error('会话绑定已变化，请检查群与原工具名称');
      this.updateKnownChat(chatId, name);
      if (isActive()) await this.options.onSynchronized?.(chatId, snapshot.id, name);
      return { pendingSync };
    });
  }

  private async observeNow<T extends NamedSessionSnapshot>(snapshot: T, entries: SessionCatalogEntry[], isActive: (scope: string) => boolean): Promise<void> {
    if (!this.options.renameSession) return;
    const seen = new Set<string>();
    for (const entry of entries) {
      const nativeId = this.options.toolId === 'codex' ? entry.threadId : entry.sessionId ?? entry.threadId;
      if (!isActive(entry.scopeId)) continue;
      // Topic-scoped threads do not own the parent group's name. Never rename
      // another bot's group from a legacy/cross-host binding.
      if (entry.botAppId !== this.options.appId || entry.status !== 'active' ||
        entry.agentId !== this.options.toolId || nativeId !== snapshot.id ||
        (this.options.sourceId !== undefined && entry.sourceId !== this.options.sourceId) ||
        !/^oc_[A-Za-z0-9]+$/.test(entry.scopeId) || seen.has(entry.scopeId)) continue;
      seen.add(entry.scopeId);
      try {
        await this.sync(entry.scopeId, snapshot, () => isActive(entry.scopeId));
      } catch (err) {
        this.retryAfter.set(this.stateKey(entry.scopeId, snapshot.id),
          (this.options.now ?? Date.now)() + NAME_SYNC_INTERVAL_MS);
        log.warn('session', 'name-sync-failed', {
          chatId: entry.scopeId, threadId: snapshot.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private stateKey(chatId: string, nativeId: string): string {
    // Preserve the existing Codex ledger on upgrade. Other tools are keyed by
    // their own identity and data source, even when native IDs happen to match.
    return this.options.toolId === 'codex' ? JSON.stringify([this.options.appId, chatId, nativeId])
      : JSON.stringify([this.options.appId, this.options.toolId, this.options.sourceId, chatId, nativeId]);
  }

  private async sync(chatId: string, snapshot: NamedSessionSnapshot, isActive: () => boolean): Promise<void> {
    const key = this.stateKey(chatId, snapshot.id);
    let state = this.states.get(key);
    const threadName = snapshot.name?.trim() ?? '';
    const now = (this.options.now ?? Date.now)();
    if (now < (this.retryAfter.get(key) ?? 0)) return;
    if (this.dirty) await this.flush();
    if (!isActive()) return;
    // Acknowledge snapshots even when the next Feishu lookup is throttled.
    // Renaming back to the original name is then a real change, not a delayed echo.
    if (state?.previousThreadName !== undefined && threadName === state.threadName) {
      state = { ...state };
      delete state.previousThreadName;
      await this.save(key, state);
    }
    const threadChanged = state && threadName && threadName !== state.threadName &&
      threadName !== state.previousThreadName;
    if (!threadChanged && now < (this.nextCheck.get(key) ?? 0)) return;
    this.nextCheck.set(key, now + (this.options.chatCheckIntervalMs ?? NAME_SYNC_INTERVAL_MS));

    let mode = this.modes.get(chatId);
    if (!mode) {
      mode = await this.options.channel.getChatMode(chatId);
      this.modes.set(chatId, mode);
    }
    if (mode !== 'group') return;
    // A stale knownChats cache is not evidence of a rename. On lookup failure
    // leave the baseline untouched and retry, never overwrite either side.
    const groupName = (await this.options.channel.getChatInfo(chatId)).name?.trim();
    if (!groupName || !isActive()) return;
    // A delayed group echo must not cancel a pending explicit request, even
    // if the native title changed independently while the worker was busy.
    if (state?.pendingSessionRename && groupName === state.previousGroupName && groupName !== state.groupName) return;

    const repairBaseline = state && state.groupName !== state.threadName &&
      groupName === state.groupName && threadName === state.threadName;
    if (!state || repairBaseline || (state.pendingSessionRename && groupName === state.groupName) || (groupName !== state.groupName && groupName !== state.previousGroupName)) {
      // First binding, or a new group rename: group wins this observation.
      // If both sides changed between checks, this is the deterministic tie-break.
      // Older/failed explicit renames can leave an unequal, unchanged baseline;
      // repair it from the confirmed group name instead of treating it as synchronized.
      if (threadName !== groupName) await this.options.renameSession!(snapshot.id, groupName);
      await this.save(key, {
        groupName, threadName: groupName,
        ...(threadName !== groupName ? { previousThreadName: threadName } : {}),
      });
      this.updateKnownChat(chatId, groupName);
      if (isActive()) await this.options.onSynchronized?.(chatId, snapshot.id, groupName);
      log.info('session', 'thread-name-synced', { threadId: snapshot.id, name: groupName });
    } else if (threadChanged) {
      if (groupName !== threadName) await renameChat(this.options.channel, chatId, threadName);
      await this.save(key, {
        groupName: threadName, threadName,
        ...(groupName !== threadName ? { previousGroupName: groupName } : {}),
      });
      this.updateKnownChat(chatId, threadName);
      if (isActive()) await this.options.onSynchronized?.(chatId, snapshot.id, threadName);
      log.info('session', 'group-name-synced', { chatId, name: threadName });
    } else {
      const confirmed = { ...state };
      if (groupName === state.groupName) delete confirmed.previousGroupName;
      if (threadName === state.threadName) delete confirmed.previousThreadName;
      if (JSON.stringify(confirmed) !== JSON.stringify(state)) await this.save(key, confirmed);
      // A restored baseline can already agree on both sides while the binding
      // label still predates it. Publish the canonical name on successful polls
      // too, retaining our expected title during delayed rename echoes.
      this.updateKnownChat(chatId, state.groupName);
      if (isActive()) await this.options.onSynchronized?.(chatId, snapshot.id, state.groupName);
    }
  }

  private updateKnownChat(chatId: string, name: string): void {
    const chat = this.options.knownChats?.().find((value) => value.id === chatId);
    if (chat) chat.name = name;
  }

  private async save(key: string, state: NameState): Promise<void> {
    this.states.set(key, state);
    this.dirty = true;
    await this.flush();
  }

  private async flush(): Promise<void> {
    await writeFileAtomic(this.options.statePath, JSON.stringify({
      version: 1, bindings: [...this.states],
    }) + '\n');
    this.dirty = false;
  }
}

/** Backwards-compatible Codex facade, including its existing persistent keys. */
export class CodexNameSync extends SessionNameSync {
  constructor(options: CodexNameSyncOptions) {
    super({ ...options, toolId: 'codex', renameSession: options.agent.setThreadName?.bind(options.agent) });
  }
}
