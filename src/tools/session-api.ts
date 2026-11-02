import type { AgentTool, BridgeSessionOperations } from './types';

/** Bridge consumers require the session API advertised by the worker. */
export function sessionOperations(tool: AgentTool): BridgeSessionOperations {
  if (!tool.sessions) throw new Error('Worker session API unavailable');
  return tool.sessions;
}
