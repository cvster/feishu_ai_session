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

/**
 * Where the native records are, as reported by the tool that owns them.
 * Record bytes never cross this interface: consumers only get a place to look.
 */
export interface SessionHistoryPointer {
  format: 'json' | 'jsonl';
  /** Absolute path on the host that owns the records; absent when no file backs the session. */
  path?: string;
  /** How to find the records when `path` is missing or has moved. Display text only. */
  hint?: string;
}

/** Provider-side view: tools hand out their own native file, worker-internal. */
export interface ToolSessionOperations {
  readonly historyMode?: 'file' | 'snapshot';
  /** False when archive only affects the bridge catalog, not native storage. */
  readonly nativeArchive?: boolean;
  /** Some tools implement the bridge archive action by deleting native history. */
  readonly archiveEffect?: 'delete';
  historyPath(nativeId: string): Promise<string | undefined>;
  /** Where this tool keeps records, for when the exported path has moved. */
  historyHint?(nativeId: string): string | undefined;
  rename(nativeId: string, name: string): Promise<void>;
  archive(nativeId: string): Promise<void>;
  fork?(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }>;
}
/** Bridge-side view: never touches provider files, only the reported pointer. */
export interface BridgeSessionOperations {
  /** False when archive only affects the bridge catalog, not native storage. */
  readonly nativeArchive?: boolean;
  readonly archiveEffect?: 'delete';
  historyPointer(nativeId: string): Promise<SessionHistoryPointer | undefined>;
  rename(nativeId: string, name: string): Promise<void>;
  archive(nativeId: string): Promise<void>;
  fork?(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }>;
}
export interface AgentTool {
  sessions?: BridgeSessionOperations;
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
  find(id: AgentKind): AgentTool | undefined { return this.tools.get(id); }
  replace(tool: AgentTool): void { this.tools.set(tool.id, tool); }
  remove(id: AgentKind): void { this.tools.delete(id); }
  has(id: AgentKind): boolean { return this.tools.has(id); }
}
