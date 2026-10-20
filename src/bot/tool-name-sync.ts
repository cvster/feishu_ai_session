import type { Controls } from '../commands';
import type { LarkChannel } from '@larksuite/channel';
import type { SessionCatalog } from '../session/catalog';
import type { AgentTool } from '../tools/types';
import { SessionNameSync } from './thread-name';
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
  const sync = new SessionNameSync({ channel: options.channel, toolId: tool.id, sourceId: tool.sourceId,
    appId: controls.profileConfig.accounts.app.id, statePath: options.statePath,
    knownChats: () => controls.knownChats ?? [],
    renameSession: (id, name) => tool.sessions!.rename(id, name),
    onSynchronized: async (scope, id, name) => {
      if (!active(scope, id)) return;
      const binding = controls.toolBindings!.get(scope)!;
      if (binding.name !== name) { controls.toolBindings!.set(scope, { ...binding, name }); await controls.toolBindings!.flush(); }
    } });
  await sync.load();
  let stopped = false, running: Promise<void> | undefined, lastWarning = 0;
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const entries = catalog.entries().filter(row => row.status === 'active' && row.agentId === tool.id && !!(row.sessionId ?? row.threadId) && active(row.scopeId, (row.sessionId ?? row.threadId)!));
      if (!entries.length || !await options.ready() || stopped) return;
      const wanted = new Set(entries.map(row => row.sessionId ?? row.threadId));
      for (const row of await tool.listSessions()) {
        if (stopped) return;
        if (!row.archived && wanted.has(row.nativeId))
          await sync.observe({ id: row.nativeId, name: row.name }, entries, scope => !stopped && active(scope, row.nativeId));
      }
    })().catch(error => {
      if (Date.now() - lastWarning > 60_000) { lastWarning = Date.now(); log.warn('session', 'native-name-poll-failed', { toolId: tool.id, error: String(error) }); }
    }).finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 10_000); timer.unref();
  void tick();
  return { tick, async stop() { stopped = true; clearInterval(timer); await running; } };
}
