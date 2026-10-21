import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import { loadRootConfig, runtimeProfileConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { log } from '../core/logger';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

interface Deps {
  channel: LarkChannel;
  controls: Controls;
  catalog: SessionCatalog;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  cancelPending(scope: string): Promise<void>;
  intervalMs?: number;
  batchSize?: number;
}

/** Missing list entries, invalid IDs and permission failures are not proof of dissolution. */
export async function chatIsDissolved(channel: LarkChannel, chatId: string): Promise<boolean> {
  try {
    const result = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
    if (result.code === 232009) return true;
    if (result.code) throw new Error(`群信息查询失败（${result.code}）`);
    if (!result.data) throw new Error('群信息查询未返回数据');
    return result.data.chat_status === 'dissolved' || result.data.chat_status === 'dissolved_save';
  } catch (error) {
    const failure = error as { code?: number; response?: { data?: { code?: number } } };
    if ((failure?.response?.data?.code ?? failure?.code) === 232009) return true;
    throw error;
  }
}

function groupIds(deps: Deps): string[] {
  const { controls, catalog, workspaces } = deps;
  const rows = catalog.entries();
  const appId = controls.profileConfig.accounts.app.id;
  const foreign = new Set(rows.filter(row => row.botAppId && row.botAppId !== appId).map(row => row.scopeId.split(':')[0]!));
  return [...new Set([
    ...rows.map(row => row.scopeId),
    ...(controls.toolBindings?.entries().map(([scope]) => scope) ?? []),
    ...Object.keys(workspaces.listCwds()),
    ...deps.sessions.scopeIds(),
    ...(controls.auxiliary?.groupIds() ?? []),
    ...controls.profileConfig.access.allowedChats,
    ...catalog.dissolvedChatIds(),
  ].map(scope => scope.split(':')[0]!))].filter(id => id.startsWith('oc_') && !foreign.has(id));
}

async function removeAllowedChat(controls: Controls, chatId: string): Promise<void> {
  if (!controls.profileConfig.access.allowedChats.includes(chatId)) return;
  await withConfigFileLock(controls.configPath, async () => {
    const root = await loadRootConfig(controls.configPath);
    const profile = root?.profiles[controls.profile];
    if (!root || !profile) throw new Error('profile config is not initialized');
    root.profiles[controls.profile] = { ...profile, access: { ...profile.access,
      allowedChats: profile.access.allowedChats.filter(id => id !== chatId),
    } };
    await saveRootConfig(root, controls.configPath);
    controls.profileConfig = root.profiles[controls.profile]!;
    controls.cfg = runtimeProfileConfig(root, controls.profile);
  });
}

async function cleanChat(deps: Deps, chatId: string): Promise<void> {
  const { controls, catalog, sessions, workspaces } = deps;
  const bindings = controls.toolBindings?.entries().filter(([scope]) => scope.split(':')[0] === chatId) ?? [];
  const rows = catalog.entries().filter(row => row.scopeId.split(':')[0] === chatId);
  const personal = !controls.auxiliary?.isAuxiliary(chatId);
  const refs = personal ? [
    ...bindings.filter(([, b]) => b.nativeId && !b.linkedSource && !b.auxiliaryWorkgroup).map(([, b]) => ({
      agentId: b.toolId, sourceId: b.sourceId, nativeId: b.nativeId!,
    })),
    ...rows.filter(row => (row.threadId || row.sessionId) &&
      !controls.toolBindings?.get(row.scopeId)?.linkedSource && !controls.toolBindings?.get(row.scopeId)?.auxiliaryWorkgroup).map(row => ({
        agentId: row.agentId, sourceId: row.sourceId ?? controls.toolRegistry?.all().find(tool => tool.id === row.agentId)?.sourceId ?? 'legacy',
        nativeId: (row.threadId ?? row.sessionId)!,
      })),
  ] : [];
  // Write ahead: a crash during route removal must not permit automatic replacement groups.
  catalog.markChatDissolved(chatId, refs);
  await catalog.flush();
  await controls.auxiliary?.closeDissolvedChat(chatId);
  const scopes = new Set([chatId, ...bindings.map(([scope]) => scope), ...rows.map(row => row.scopeId),
    ...Object.keys(workspaces.listCwds()).filter(scope => scope.startsWith(`${chatId}:`)),
    ...sessions.scopeIds().filter(scope => scope.startsWith(`${chatId}:`)),
  ]);
  for (const scope of scopes) {
    await deps.cancelPending(scope);
    sessions.remove(scope);
    workspaces.removeCwd(scope);
  }
  controls.toolBindings?.removeChat(chatId);
  await Promise.all([sessions.flush(), workspaces.flush(), controls.toolBindings?.flush()]);
  await removeAllowedChat(controls, chatId);
  controls.knownChats = controls.knownChats?.filter(chat => chat.id !== chatId);
  log.info('group-cleanup', 'dissolved-chat-cleaned', { chatId, scopes: scopes.size });
}

/** Read-only Feishu probes; only local routing state is changed after confirmed dissolution. */
export function createGroupCleanup(deps: Deps): { start(): Promise<void>; runNow(): Promise<void>; stop(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let cursor = 0;
  const completed = new Set<string>();
  const scan = async () => {
    const ids = groupIds(deps).filter(id => !completed.has(id));
    if (!ids.length) return;
    const start = cursor % ids.length;
    const count = Math.min(deps.batchSize ?? 50, ids.length);
    cursor = (start + count) % ids.length;
    for (let n = 0; n < count && !stopped; n++) {
      const chatId = ids[(start + n) % ids.length]!;
      try {
        if (!deps.catalog.isChatDissolved(chatId) && !await chatIsDissolved(deps.channel, chatId)) continue;
        if (stopped) break;
        await cleanChat(deps, chatId);
        completed.add(chatId);
      } catch (error) {
        log.warn('group-cleanup', 'check-or-cleanup-failed', { chatId, error: String(error) });
      }
    }
  };
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (deps.controls.withAaSessionGroupSyncPaused?.(scan) ?? scan()).finally(() => { running = undefined; });
    return running;
  };
  return {
    async start() {
      await runNow();
      if (stopped || timer) return;
      timer = setInterval(() => { void runNow().catch(error => log.fail('group-cleanup', error)); }, deps.intervalMs ?? 60_000);
      timer.unref();
    },
    runNow,
    async stop() { stopped = true; if (timer) clearInterval(timer); await running; },
  };
}
