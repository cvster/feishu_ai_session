import type { AgentAdapter } from '../agent/types';
import type { AgentKind } from '../config/profile-schema';

export interface ToolSession {
  nativeId: string;
  name?: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  archived?: boolean;
}

/** Provider-specific formats and protocols stay behind this interface. */
export interface AgentTool {
  id: AgentKind;
  sourceId: string;
  label: string;
  agent: AgentAdapter;
  reserveSessionId?(): string;
  listSessions(): Promise<ToolSession[]>;
}

export class ToolRegistry {
  private readonly tools = new Map<AgentKind, AgentTool>();
  register(tool: AgentTool): void {
    if (this.tools.has(tool.id)) throw new Error(`Duplicate tool: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }
  get(id: AgentKind): AgentTool {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`执行工具未配置：${id}`);
    return tool;
  }
  all(): AgentTool[] { return [...this.tools.values()]; }
}
