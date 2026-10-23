import type { Controls } from '../commands';
import type { LarkChannel } from '@larksuite/channel';
import type { SessionCatalog } from '../session/catalog';
import type { AgentTool } from '../tools/types';
import { sessionOperations } from '../tools/session-api';
import { join } from 'node:path';
import { DurableAgentAdapter } from '../worker/adapter';
import { NAME_SYNC_INTERVAL_MS, SessionNameSync } from './thread-name';
import { log } from '../core/logger';

/** Poll native metadata only; remote mutations go through the owning worker. */
export async function startToolNameSync(options: {
  channel: LarkChannel; controls: Controls; catalog: SessionCatalog;
  tool: AgentTool; statePath: string; ready(): Promise<boolean>; intervalMs?: number;
}) {
  const { controls, catalog, tool } = options;
  const active = (scope: string, id: string) => {
    const binding = controls.toolBindings?.get(scope);
    return !!binding && binding.toolId === tool.id && binding.sourceId === tool.sourceId && binding.nativeId === id &&
      !binding.linkedSource && !binding.auxiliaryWorkgroup && !controls.auxiliary?.isAuxiliary(scope) &&
      !catalog.isScopeArchived(scope) && !controls.toolBindings!.isArchived(tool.id, tool.sourceId, id);
  };
  const ownedEntries = () => catalog.entries().filter(row => row.status === 'active' && row.agentId === tool.id &&
    (row.sourceId === undefined || row.sourceId === tool.sourceId) && row.botAppId === controls.profileConfig.accounts.app.id &&
    /^oc_[A-Za-z0-9]+$/.test(row.scopeId) && !!(row.sessionId ?? row.threadId) && active(row.scopeId, (row.sessionId ?? row.threadId)!))
    // Legacy catalog rows lack sourceId. Normalize only after the current
    // binding has verified this exact worker source and native session.
    .map(row => row.sourceId === undefined ? { ...row, sourceId: tool.sourceId } : row);
  // Two personal groups sharing a native session must not fight over its title.
  // A scope can have several catalog rows after a policy/source migration;
  // those rows still represent one group, not competing personal bindings.
  const exclusive = (scope: string, id: string) => active(scope, id) &&
    new Set(ownedEntries().filter(row => (row.sessionId ?? row.threadId) === id).map(row => row.scopeId)).size === 1;
  const sync = new SessionNameSync({ channel: options.channel, toolId: tool.id, sourceId: tool.sourceId,
    appId: controls.profileConfig.accounts.app.id, statePath: options.statePath,
    // This poller's timer already throttles lookups. A second throttle would
    // skip a poll when worker metadata arrives faster than on the prior tick.
    chatCheckIntervalMs: 0,
    knownChats: () => controls.knownChats ?? [],
    renameSession: (id, name) => sessionOperations(tool).rename(id, name),
    onSynchronized: async (scope, id, name) => {
      if (!exclusive(scope, id)) return;
      const binding = controls.toolBindings!.get(scope)!;
      if (binding.name !== name) { controls.toolBindings!.set(scope, { ...binding, name }); await controls.toolBindings!.flush(); }
    } });
  await sync.load();
  let stopped = false, running: Promise<void> | undefined, lastWarning = 0;
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const entries = ownedEntries().filter(row => exclusive(row.scopeId, (row.sessionId ?? row.threadId)!));
      if (!entries.length || !await options.ready() || stopped) return;
      const wanted = new Set(entries.map(row => row.sessionId ?? row.threadId));
      for (const row of await tool.listSessions()) {
        if (stopped) return;
        if (!row.archived && wanted.has(row.nativeId))
          await sync.observe({ id: row.nativeId, name: row.name }, entries, scope => !stopped && exclusive(scope, row.nativeId));
      }
    })().catch(error => {
      if (Date.now() - lastWarning > 60_000) { lastWarning = Date.now(); log.warn('session', 'native-name-poll-failed', { toolId: tool.id, error: String(error) }); }
    }).finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? NAME_SYNC_INTERVAL_MS); timer.unref();
  void tick();
  return { tick, async stop() { stopped = true; clearInterval(timer); await running; } };
}

/** Metadata support is advertised by each worker. */
export async function startWorkerNameSync(options: {
  channel: LarkChannel; controls: Controls; catalog: SessionCatalog; profileDir: string; intervalMs?: number;
}) {
  const handles: Awaited<ReturnType<typeof startToolNameSync>>[] = [];
  for (const tool of options.controls.toolRegistry?.all() ?? []) {
    if (!tool.sessions || !(tool.agent instanceof DurableAgentAdapter)) continue;
    const agent = tool.agent;
    try {
      handles.push(await startToolNameSync({ ...options, tool,
        statePath: join(options.profileDir, `${tool.id}-name-sync.json`),
        ready: async () => {
          await agent.prepareRun();
          const health = await agent.client.health();
          return health.capabilities?.nativeSessionNames === true && health.capabilities.sessions.list && health.capabilities.sessions.rename;
        } }));
    } catch (error) { log.warn('session', 'name-sync-disabled', { toolId: tool.id, error: String(error) }); }
  }
  return {
    async tick() { await Promise.all(handles.map(handle => handle.tick())); },
    async stop() { await Promise.all(handles.map(handle => handle.stop())); },
  };
}
