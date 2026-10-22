import { nativeSessionFields, nativeSessionId, toolDefinition } from '../tools/definitions';
import { controlsForTool } from '../tools/context';
import { isPersonalWorkgroup } from '../tools/bindings';
import type { AgentKind } from '../config/profile-schema';
import type { LarkChannel } from '@larksuite/channel';
import { capabilityForTool } from '../agent/capability';
import { sendManagedCard } from '../card/managed';
import { newChatWorkspaceCard } from '../card/templates';
import { loadRootConfig, runtimeProfileConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import { canUseGroup } from '../policy/access';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalog, SessionCatalogEntry } from '../session/catalog';
import { type CodexThreadHistoryEntry } from '../session/codex-history';
import type { WorkspaceStore } from '../workspace/store';
import { ensureSessionGroupAvatar } from './group-avatar';
import { createBoundChat, renameChat } from './group';
import { fetchKnownChatsResult, type KnownChat } from './lark-info';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 10_000;
const AA_RECENT_TURN_REPLAY_COUNT = 3;

export interface AaSessionGroupSyncDeps {
  channel: LarkChannel;
  controls: Controls;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileStateDir: string;
  intervalMs?: number;
  historyProvider?: (options: import('../session/codex-history').ListCodexThreadHistoryOptions) => Promise<CodexThreadHistoryEntry[]>;
  toolId?: AgentKind;
  sourceId?: string;
}

export interface AaSessionGroupSyncHandle {
  runNow(): Promise<void>;
  withPaused<T>(operation: () => Promise<T>): Promise<T>;
  stop(): void;
}

export function startAaSessionGroupSync(deps: AaSessionGroupSyncDeps): AaSessionGroupSyncHandle {
  let stopped = false;
  let running: Promise<void> | undefined;
  let paused = 0;
  const runNow = async (): Promise<void> => {
    if (stopped || paused > 0) return;
    if (running) return running;
    running = syncAaSessionGroupsOnce(deps)
      .catch((err) => log.fail('aa-session-groups', err, { step: 'sync' }))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
  timer.unref?.();
  return {
    runNow,
    async withPaused<T>(operation: () => Promise<T>): Promise<T> {
      paused++;
      try {
        await running;
        return await operation();
      } finally {
        paused--;
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function syncAaSessionGroupsOnce(deps: AaSessionGroupSyncDeps): Promise<void> {
  if (!deps.controls.toolRegistry) return;
  for (const tool of deps.controls.toolRegistry.all()) {
    try {
      if (!await tool.agent.isAvailable()) continue;
      const rows = await tool.listSessions();
      let archived = false;
      for (const row of rows) if (row.archived === true) {
        const linked = deps.sessionCatalog.entries().some(e => e.status === 'active' && e.agentId === tool.id &&
          nativeSessionId(tool.id, e) === row.nativeId && (!e.sourceId || e.sourceId === tool.sourceId) &&
          (!e.botAppId || e.botAppId === deps.controls.profileConfig.accounts.app.id));
        if (!linked) continue;
        deps.controls.toolBindings?.archive(tool.id, tool.sourceId, row.nativeId);
        deps.sessionCatalog.archiveNativeSession(tool.id, row.nativeId, tool.sourceId, true);
        archived = true;
      }
      if (archived) {
        await Promise.all([deps.sessionCatalog.flush(), deps.controls.toolBindings?.flush()]);
        await deps.controls.sessionArchiveNotifications?.flush();
      }
      await syncAaToolOnce({ ...deps, toolId: tool.id, sourceId: tool.sourceId,
        controls: controlsForTool(deps.controls, tool.id),
        historyProvider: async () => rows.filter(row => !row.archived).map(row => ({
          threadId: row.nativeId, name: row.name, cwd: row.cwd,
          createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, preview: '', source: tool.id,
        })),
      });
    } catch (err) { log.fail('aa-session-groups', err, { toolId: tool.id, step: 'discover' }); }
  }
}

async function syncAaToolOnce(deps: AaSessionGroupSyncDeps): Promise<void> {
  const toolId = deps.toolId ?? deps.controls.profileConfig.agentKind;
  const sourceId = deps.sourceId ?? 'legacy';
  const capability = capabilityForTool(toolId, deps.controls.profileConfig);
  const nativeId = (entry: SessionCatalogEntry) => nativeSessionId(toolId, entry);
  const isBinding = (entry: SessionCatalogEntry) => isPersonalWorkgroup(entry.scopeId, deps.controls.toolBindings?.get(entry.scopeId)) && entry.agentId === toolId && (!entry.sourceId || entry.sourceId === sourceId) && isCurrentBotBinding(entry, currentBotAppId, knownChatIds);
  const isArchived = (id: string) => deps.controls.toolBindings?.isArchived(toolId, sourceId, id);
  const isSuppressed = (id: string) => deps.sessionCatalog.isAutoGroupSuppressed?.(toolId, sourceId, id);

  const inviteOpenIds = concreteInviteOpenIds(deps.controls);
  const actorId = deps.controls.botOwnerId ?? inviteOpenIds[0];
  if (!actorId || inviteOpenIds.length === 0) {
    log.warn('aa-session-groups', 'missing-invite-user', {
      ownerRefreshState: deps.controls.ownerRefreshState,
    });
    return;
  }

  if (!deps.historyProvider) return;
  const history = await deps.historyProvider({ limit: HISTORY_LIMIT } as any);
  // Chat visibility is scoped by the credentials on this channel. Fetch it before
  // trusting catalog bindings so entries left by another bot cannot suppress group creation.
  const knownChatsResult = await fetchKnownChatsResult(deps.channel);
  if (!knownChatsResult.ok) {
    log.warn('aa-session-groups', 'sync-skipped-chat-list-unavailable');
    return;
  }
  deps.controls.knownChats = knownChatsResult.chats;
  const knownChatIds = new Set(knownChatsResult.chats.map((chat) => chat.id));
  const currentBotAppId = deps.controls.profileConfig.accounts.app.id;
  const catalogEntries = deps.sessionCatalog.entries();
  // An owned group missing from a partial/visibility-limited list must first be
  // checked by group cleanup, rather than immediately replaced by this scanner.
  const unverifiedOwnedThreads = new Set(catalogEntries.filter(entry => entry.agentId === toolId &&
    entry.botAppId === currentBotAppId && entry.status === 'active' && isPersonalWorkgroup(entry.scopeId, deps.controls.toolBindings?.get(entry.scopeId)) &&
    (!entry.sourceId || entry.sourceId === sourceId) && !knownChatIds.has(entry.scopeId))
    .map(entry => nativeId(entry)).filter(Boolean));
  const boundThreadIds = new Set(
    catalogEntries
      .filter((entry) =>
        isBinding(entry) && nativeId(entry),
      )
      .map((entry) => nativeId(entry)!),
  );
  const isPersonalScope = (scope: string) => !scope.includes(':') && !deps.controls.auxiliary?.isAuxiliary(scope) &&
    !deps.controls.toolBindings?.get(scope)?.linkedSource;
  const personalChats = new Set(catalogEntries.filter(entry => isBinding(entry) && isPersonalScope(entry.scopeId) &&
    !deps.sessionCatalog.isScopeArchived?.(entry.scopeId)).map(entry => entry.scopeId));
  for (const chatId of personalChats) await ensureSessionGroupAvatar(deps.channel, toolId, chatId).catch(error =>
    log.warn('group-avatar', 'backfill-failed', { toolId, chatId, error: errorText(error) }));
  const aaCandidates = latestVersionSessions(history).filter(
    (thread) => isAaSession(thread) && !deps.controls.auxiliary?.isAuxiliaryNative(toolId, sourceId, thread.threadId) && !boundThreadIds.has(thread.threadId) &&
      !deps.controls.toolBindings?.personalOwner({ toolId, sourceId, nativeId: thread.threadId }) &&
      !isArchived(thread.threadId) && !isSuppressed(thread.threadId) && !unverifiedOwnedThreads.has(thread.threadId),
  );
  const candidates = aaCandidates;
  if (candidates.length === 0) return;

  const usedNames = new Set(knownChatsResult.chats.map((chat) => chat.name.trim()));
  const historyByThreadId = new Map(history.map((thread) => [thread.threadId, thread]));

  const synchronize = async (thread: CodexThreadHistoryEntry) => {
    // The shared lease makes manual and automatic creation atomic for this native ID.
    if (deps.controls.toolBindings?.personalOwner({ toolId, sourceId, nativeId: thread.threadId })) return;
    if (isArchived(thread.threadId) || isSuppressed(thread.threadId)) return;
    // Another timer/manual action may have bound it while this sync was awaiting I/O.
    if (deps.sessionCatalog.entries().some(
      (entry) =>
        nativeId(entry) === thread.threadId && isBinding(entry),
    )) return;

    const workspace = await resolveWorkingDirectory(thread.cwd);
    if (!workspace.ok) {
      log.warn('aa-session-groups', 'invalid-workspace', {
        threadId: thread.threadId,
        cwd: thread.cwd,
      });
      return;
    }
    const current = await deps.controls.toolRegistry?.find(toolId)?.listSessions();
    if (current && !current.some(row => row.nativeId === thread.threadId && !row.archived)) return;
    const previous = findPreviousVersionBinding(
      thread,
      deps.sessionCatalog.entries().filter((entry) => isBinding(entry) && !deps.sessionCatalog.isScopeArchived?.(entry.scopeId)).map(entry => ({ ...entry, threadId: nativeId(entry) })),
      historyByThreadId,
      currentBotAppId,
      knownChatIds,
    );
    if (previous) {
      const oldChat: KnownChat | undefined = deps.controls.knownChats?.find(
        (chat) => chat.id === previous.scopeId,
      );
      const namesWithoutCurrent = new Set(usedNames);
      if (oldChat?.name) namesWithoutCurrent.delete(oldChat.name.trim());
      const name = deps.toolId ? uniqueToolGroupName(thread.name!, namesWithoutCurrent, toolId) : uniqueGroupName(thread.name!, namesWithoutCurrent);
      const access = canUseGroup(
        deps.controls.profileConfig,
        deps.controls,
        previous.scopeId,
        actorId,
      );
      const policy = evaluateRunPolicy({
        scope: { source: 'im', chatId: previous.scopeId, actorId },
        attachments: [],
        prompt: '',
        requestedCwd: workspace.cwdRealpath,
        cwdRealpath: workspace.cwdRealpath,
        access,
        capability,
        profileConfig: deps.controls.profileConfig,
        now: Date.now(),
      });
      if (!policy.ok) {
        log.warn('aa-session-groups', 'policy-denied-before-upgrade', {
          chatId: previous.scopeId,
          threadId: thread.threadId,
        });
        return;
      }
      try {
        if (isArchived(thread.threadId) ||
            deps.sessionCatalog.isScopeArchived?.(previous.scopeId)) return;
        if (oldChat?.name.trim() !== name) {
          await renameChat(deps.channel, previous.scopeId, name);
        }
        deps.sessionCatalog.archiveActive(previous);
        deps.sessionCatalog.archiveNativeSession(toolId, thread.threadId, sourceId);
        deps.sessionCatalog.upsertActive({
          scopeId: previous.scopeId,
          agentId: toolId,
          sourceId,
          cwdRealpath: workspace.cwdRealpath,
          policyFingerprint: policy.policyFingerprint,
          ...nativeSessionFields(toolId, thread.threadId),
          botAppId: currentBotAppId,
          recentTurnReplayCount: null,
        });
        deps.controls.toolBindings?.set(previous.scopeId, { toolId, sourceId, nativeId: thread.threadId, nativeCreated: true, name });
        await deps.controls.toolBindings?.flush();
        deps.workspaces.setCwd(previous.scopeId, workspace.cwdRealpath);
        await Promise.all([deps.workspaces.flush(), deps.sessionCatalog.flush()]);
        await persistAllowedChat(deps.controls, previous.scopeId);
      } catch (err) {
        log.fail('aa-session-groups', err, {
          step: 'upgrade-chat',
          chatId: previous.scopeId,
          threadId: thread.threadId,
        });
        return;
      }
      if (oldChat?.name) usedNames.delete(oldChat.name.trim());
      usedNames.add(name);
      deps.controls.knownChats = [
        ...(deps.controls.knownChats ?? []).filter((chat) => chat.id !== previous.scopeId),
        { id: previous.scopeId, name },
      ];
      boundThreadIds.add(thread.threadId);
      await sendManagedCard(
        deps.channel,
        previous.scopeId,
        newChatWorkspaceCard(name, { threadId: thread.threadId, existing: true }, toolId),
      ).catch((err) => log.warn('aa-session-groups', 'upgrade-welcome-failed', {
        chatId: previous.scopeId,
        err: errorText(err),
      }));
      log.info('aa-session-groups', 'upgraded', {
        chatId: previous.scopeId,
        fromThreadId: previous.threadId,
        threadId: thread.threadId,
        name,
      });
      return;
    }
    const name = deps.toolId ? uniqueToolGroupName(thread.name!, usedNames, toolId) : uniqueGroupName(thread.name!, usedNames);
    let created;
    try {
      if (isArchived(thread.threadId) || isSuppressed(thread.threadId)) return;
      created = await createBoundChat({
        channel: deps.channel,
        name,
        inviteOpenIds,
        toolId,
        description: `自动绑定 ${toolDefinition(toolId).label} 会话 ${thread.threadId}`,
      });
    } catch (err) {
      log.fail('aa-session-groups', err, { step: 'create-chat', threadId: thread.threadId });
      return;
    }

    deps.workspaces.setCwd(created.chatId, workspace.cwdRealpath);
    const access = canUseGroup(
      deps.controls.profileConfig,
      deps.controls,
      created.chatId,
      actorId,
    );
    const policy = evaluateRunPolicy({
      scope: { source: 'im', chatId: created.chatId, actorId },
      attachments: [],
      prompt: '',
      requestedCwd: workspace.cwdRealpath,
      cwdRealpath: workspace.cwdRealpath,
      access,
      capability,
      profileConfig: deps.controls.profileConfig,
      now: Date.now(),
    });
    if (!policy.ok) {
      log.warn('aa-session-groups', 'policy-denied-after-create', {
        chatId: created.chatId,
        threadId: thread.threadId,
      });
      return;
    }
    // Retire bindings for this thread that belonged to a previous bot before
    // recording the newly created group for the authenticated bot.
    deps.sessionCatalog.archiveNativeSession(toolId, thread.threadId, sourceId);
    deps.sessionCatalog.upsertActive({
      scopeId: created.chatId,
      agentId: toolId,
      sourceId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
      ...nativeSessionFields(toolId, thread.threadId),
      botAppId: currentBotAppId,
      recentTurnReplayCount: AA_RECENT_TURN_REPLAY_COUNT,
    });
    deps.controls.toolBindings?.set(created.chatId, { toolId, sourceId, nativeId: thread.threadId, nativeCreated: true, name: created.name });
    await deps.controls.toolBindings?.flush();
    await Promise.all([deps.workspaces.flush(), deps.sessionCatalog.flush()]);
    await persistAllowedChat(deps.controls, created.chatId).catch((err) =>
      log.fail('aa-session-groups', err, { step: 'allow-chat', chatId: created.chatId }),
    );
    deps.controls.knownChats = [
      ...(deps.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
      { id: created.chatId, name: created.name },
    ];
    knownChatIds.add(created.chatId);
    usedNames.add(created.name);
    boundThreadIds.add(thread.threadId);
    await sendManagedCard(
      deps.channel,
      created.chatId,
      newChatWorkspaceCard(created.name, { threadId: thread.threadId, existing: true }, toolId),
    ).catch((err) => log.warn('aa-session-groups', 'welcome-failed', {
      chatId: created.chatId,
      err: errorText(err),
    }));
    log.info('aa-session-groups', 'created', {
      chatId: created.chatId,
      threadId: thread.threadId,
      name: created.name,
    });
  };
  for (const thread of candidates) {
    if (deps.controls.toolBindings) await deps.controls.toolBindings.withPersonalBinding({ toolId, sourceId, nativeId: thread.threadId }, () => synchronize(thread));
    else await synchronize(thread);
  }
}

function isCurrentBotBinding(
  entry: SessionCatalogEntry,
  currentBotAppId: string,
  knownChatIds: Set<string>,
): boolean {
  if (entry.status !== 'active') return false;
  if (!knownChatIds.has(entry.scopeId)) return false;
  return !entry.botAppId || entry.botAppId === currentBotAppId;
}

export function isAaSession(thread: CodexThreadHistoryEntry): boolean {
  return Boolean(thread.name?.trimStart().startsWith('AA'));
}

export interface AaSessionVersion {
  family: string;
  version?: number;
}

export function aaSessionVersion(name: string): AaSessionVersion {
  const normalized = normalizeTitle(name);
  const match = /^(.*?)(\d{1,2})$/u.exec(normalized);
  const family = match?.[1]?.trimEnd();
  if (!match || !family) return { family: normalized };
  return { family, version: Number.parseInt(match[2]!, 10) };
}

function latestVersionSessions(history: CodexThreadHistoryEntry[]): CodexThreadHistoryEntry[] {
  const latest = new Map<string, CodexThreadHistoryEntry>();
  for (const thread of history) {
    if (!isAaSession(thread) || !thread.name) continue;
    const parsed = aaSessionVersion(thread.name);
    if (parsed.version === undefined) {
      latest.set(`thread:${thread.threadId}`, thread);
      continue;
    }
    const key = `family:${parsed.family}`;
    const current = latest.get(key);
    if (!current || isNewerVersion(thread, current)) latest.set(key, thread);
  }
  return [...latest.values()];
}

function isNewerVersion(
  candidate: CodexThreadHistoryEntry,
  current: CodexThreadHistoryEntry,
): boolean {
  const candidateVersion = aaSessionVersion(candidate.name ?? '').version ?? -1;
  const currentVersion = aaSessionVersion(current.name ?? '').version ?? -1;
  if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
  return candidate.updatedAtMs > current.updatedAtMs;
}

function findPreviousVersionBinding(
  target: CodexThreadHistoryEntry,
  entries: SessionCatalogEntry[],
  historyByThreadId: Map<string, CodexThreadHistoryEntry>,
  currentBotAppId: string,
  knownChatIds: Set<string>,
): SessionCatalogEntry | undefined {
  if (!target.name) return undefined;
  const targetVersion = aaSessionVersion(target.name);
  if (targetVersion.version === undefined) return undefined;
  return entries
    .filter((entry) => {
      if (!entry.threadId || !isCurrentBotBinding(entry, currentBotAppId, knownChatIds)) return false;
      const previous = historyByThreadId.get(entry.threadId);
      if (!previous?.name) return false;
      const previousVersion = aaSessionVersion(previous.name);
      return previousVersion.family === targetVersion.family &&
        previousVersion.version !== undefined &&
        previousVersion.version < targetVersion.version!;
    })
    .sort((a, b) => {
      const aVersion = aaSessionVersion(historyByThreadId.get(a.threadId!)?.name ?? '').version ?? -1;
      const bVersion = aaSessionVersion(historyByThreadId.get(b.threadId!)?.name ?? '').version ?? -1;
      return bVersion - aVersion || b.updatedAt - a.updatedAt;
    })[0];
}

function concreteInviteOpenIds(controls: Controls): string[] {
  return [...new Set([
    ...(controls.botOwnerId ? [controls.botOwnerId] : []),
    ...controls.profileConfig.access.admins,
  ].filter((id) => /^ou_[A-Za-z0-9]+$/.test(id)))];
}

export function uniqueToolGroupName(title: string, usedNames: Set<string>, toolId: AgentKind): string {
  const normalized = normalizeTitle(title);
  return uniqueGroupName(usedNames.has(normalized) ? `${normalized}（${toolDefinition(toolId).label}）` : normalized, usedNames);
}

function uniqueGroupName(title: string, usedNames: Set<string>): string {
  const base = normalizeTitle(title).slice(0, 48) || 'AA Codex会话';
  if (!usedNames.has(base)) return base;
  let suffix = 2;
  while (usedNames.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function persistAllowedChat(controls: Controls, chatId: string): Promise<void> {
  if (controls.profileConfig.access.allowedChats.includes('*') ||
      controls.profileConfig.access.allowedChats.includes(chatId)) return;
  await withConfigFileLock(controls.configPath, async () => {
    const root = await loadRootConfig(controls.configPath);
    if (!root) throw new Error('profile config is not initialized');
    const profile = root.profiles[controls.profile];
    if (!profile) throw new Error(`profile not found: ${controls.profile}`);
    root.profiles[controls.profile] = {
      ...profile,
      access: {
        ...profile.access,
        allowedChats: [...new Set([...profile.access.allowedChats, chatId])],
      },
    };
    await saveRootConfig(root, controls.configPath);
    controls.profileConfig = root.profiles[controls.profile]!;
    controls.cfg = runtimeProfileConfig(root, controls.profile);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
