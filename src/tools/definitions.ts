/** Static provider manifest. Unknown tools are rejected, never treated as another provider. */
export const TOOL_DEFINITIONS = {
  codex: { label: 'Codex', backend: 'native-queue', nativeField: 'threadId', fork: true, reasoning: true, sessionKind: 'codex-thread', promptInjection: 'none', nativeHistory: false, legacyMarkers: [] },
  claude: { label: 'Claude Code', backend: 'worker', nativeField: 'sessionId', fork: false, reasoning: true, sessionKind: 'claude-session', promptInjection: 'none', nativeHistory: true, legacyMarkers: ['__claude_cb'] },
  dsh: { label: 'DeepSeek Harness', backend: 'worker', nativeField: 'sessionId', fork: true, reasoning: true, sessionKind: 'dsh-session', promptInjection: 'none', nativeHistory: false, legacyMarkers: [] },
  kilo: { label: 'Kilo', backend: 'worker', nativeField: 'sessionId', fork: true, reasoning: true, sessionKind: 'kilo-session', promptInjection: 'none', nativeHistory: false, legacyMarkers: [] },
  zcode: { label: 'ZCode', backend: 'worker', nativeField: 'sessionId', fork: true, reasoning: true, sessionKind: 'zcode-session', promptInjection: 'none', nativeHistory: false, legacyMarkers: [] },
} as const;
export type ToolId = keyof typeof TOOL_DEFINITIONS;
export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && Object.hasOwn(TOOL_DEFINITIONS, value);
}
export function toolDefinition(id: ToolId) {
  if (!isToolId(id)) throw new Error(`未注册的执行工具：${String(id)}`);
  return TOOL_DEFINITIONS[id];
}
export interface SessionRef { toolId: ToolId; sourceId: string; nativeId: string }
/** Compatibility boundary for existing catalogs; native IDs remain opaque outside providers. */
export function nativeSessionFields(id: ToolId, nativeId: string): { threadId?: string; sessionId?: string } {
  return { [toolDefinition(id).nativeField]: nativeId };
}
export function nativeSessionId(id: ToolId, row: { threadId?: string; sessionId?: string }): string | undefined {
  return row[toolDefinition(id).nativeField];
}
export function workerStateDirName(id: ToolId): string { return id === 'claude' ? 'execution-worker' : `execution-worker-${id}`; }
export function workerInboxName(id: ToolId): string { return `${id}-inbox.json`; }
export function workerRepliesName(id: ToolId): string { return id === 'claude' ? 'worker-replies.json' : `${id}-worker-replies.json`; }
