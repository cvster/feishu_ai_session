import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTool, ToolSessionOperations } from './types';
import type { ToolId } from './definitions';

/** Provider-owned history formats. No consumer assumes UUIDs or transcript locations. */
export async function findNativeHistory(toolId: ToolId, sourceId: string, nativeId: string): Promise<string | undefined> {
  if (!/^[\da-f-]{36}$/i.test(nativeId) || !['codex', 'claude'].includes(toolId)) return;
  for (const root of nativeRoots(toolId, sourceId)) { const path = await walkNative(root, nativeId); if (path) return path; }
}
function nativeRoots(toolId: ToolId, sourceId: string): string[] {
  return toolId === 'claude' ? [join(sourceId, 'projects')] : [join(sourceId, 'sessions'), join(sourceId, 'archived_sessions')];
}
async function walkNative(dir: string, nativeId: string, depth = 0): Promise<string | undefined> {
  let files; try { files = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  for (const file of files) {
    if (file.isFile() && (file.name === `${nativeId}.jsonl` || file.name.endsWith(`-${nativeId}.jsonl`))) return join(dir, file.name);
    if (file.isDirectory() && depth < 4) { const found = await walkNative(join(dir, file.name), nativeId, depth + 1); if (found) return found; }
  }
}
export function nativeSessionOperations(tool: Pick<AgentTool, 'id' | 'sourceId' | 'agent'>): ToolSessionOperations {
  return {
    historyMode: 'file',
    nativeArchive: tool.id === 'codex',
    historyPath: id => findNativeHistory(tool.id, tool.sourceId, id),
    // Records move when a session is archived, so the pointer alone is not enough.
    historyHint: id => ['codex', 'claude'].includes(tool.id) && /^[\da-f-]{36}$/i.test(id)
      ? `原生会话记录保存在 ${nativeRoots(tool.id, tool.sourceId).join(' 或 ')} 下，文件名形如 <会话 ID>.jsonl；按会话 ID 查找后用 rg/sed 分段读取。`
      : undefined,
    async rename(id, name) {
      if (tool.id === 'codex') { if (!tool.agent.setThreadName) throw new Error('Codex 未提供会话改名能力'); await tool.agent.setThreadName(id, name); return; }
      if (tool.id !== 'claude') throw new Error(`${tool.id} 不支持原生会话改名`);
      const path = await findNativeHistory(tool.id, tool.sourceId, id);
      if (!path) throw new Error('辅助 Claude 会话记录不可读');
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND);
      try { await file.writeFile(JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: name }) + '\n'); } finally { await file.close(); }
    },
    async archive(id) { if (tool.id === 'codex') { if (!tool.agent.archiveThread) throw new Error('当前 Codex 未提供原生归档能力。'); await tool.agent.archiveThread(id); } },
  };
}
export { sessionOperations } from './session-api';
