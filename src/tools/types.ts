import { isToolId } from './definitions';
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
export interface ToolSessionOperations {
  readonly historyMode?: 'file' | 'snapshot';
  historyPath(nativeId: string): Promise<string | undefined>;
  rename(nativeId: string, name: string): Promise<void>;
  archive(nativeId: string): Promise<void>;
  fork?(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }>;
}
export interface AgentTool {
  sessions?: ToolSessionOperations;
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
    if (!isToolId(tool.id)) throw new Error(`未注册的执行工具：${String(tool.id)}`);
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
