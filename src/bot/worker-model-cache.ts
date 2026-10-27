import { cachedModelChoices, modelCachePath } from '../agent/model-cache';
import { DEFAULT_MODEL } from '../agent/models';
import type { AgentTool } from '../tools/types';
import { log } from '../core/logger';

export const MODEL_CACHE_REFRESH_MS = 30 * 60_000;

/** Startup/new workers warm immediately; known catalogues refresh every 30 minutes. */
export function startWorkerModelCache(options: {
  profileDir: string; botAppId: string; tools(): AgentTool[];
  projects?(tool: AgentTool): string[]; intervalMs?: number;
}) {
  const interval = options.intervalMs ?? MODEL_CACHE_REFRESH_MS;
  const attempted = new Map<string, number>();
  let stopped = false, running: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const tools = options.tools();
      await Promise.allSettled(tools.map(async tool => {
        if (!tool.agent.listModels) return;
        const projects = [undefined, ...new Set(options.projects?.(tool).filter(Boolean) ?? [])];
        for (const cwd of projects) {
          if (stopped) return;
          const path = modelCachePath(options.profileDir, options.botAppId, tool.id, tool.sourceId, cwd);
          const now = Date.now(), previous = attempted.get(path);
          if (previous !== undefined && now - previous < interval) continue;
          attempted.set(path, now);
          try {
            const choices = await cachedModelChoices(path, tool.agent, cwd, DEFAULT_MODEL, true, { isActive: () => !stopped });
            if (!stopped && choices.notice) log.warn('worker', 'model-cache-refresh-failed', { toolId: tool.id });
          } catch { if (!stopped) log.warn('worker', 'model-cache-save-failed', { toolId: tool.id }); }
        }
      }));
    })().finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => void tick(), interval); timer.unref();
  void tick();
  return { tick, stop() { stopped = true; clearInterval(timer); } };
}
