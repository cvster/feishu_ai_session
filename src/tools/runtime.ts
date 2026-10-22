import type { ProfileConfig, AgentKind } from '../config/profile-schema';
import type { AppPaths } from '../config/app-paths';
import type { AgentAdapter } from '../agent/types';
import { ToolRegistry } from './types';
import { loadWorkerRegistry, workerTool } from '../worker/discovery';

/** The bridge learns tool identities exclusively from worker endpoints. */
export async function createToolRegistry(profile: ProfileConfig, paths: AppPaths, _primary?: AgentAdapter): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  for (const worker of await loadWorkerRegistry(paths.profileDir, profile.accounts.app.id)) registry.register(workerTool(worker));
  return registry;
}
export function toolProfile(profile: ProfileConfig, toolId: AgentKind): ProfileConfig {
  return { ...profile, agentKind: toolId, preferences: { ...profile.preferences,
    model: toolId === profile.agentKind ? profile.preferences.model : undefined,
    reasoningEffort: toolId === profile.agentKind ? profile.preferences.reasoningEffort : undefined } };
}
