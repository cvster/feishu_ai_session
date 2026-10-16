import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTool, ToolSessionOperations } from './types';
import type { ToolId } from './definitions';

/** Provider-owned history formats. No consumer assumes UUIDs or transcript locations. */
export async function findNativeHistory(toolId: ToolId, sourceId: string, nativeId: string): Promise<string | undefined> {
  if (!/^[\da-f-]{36}$/i.test(nativeId) || !['codex', 'claude'].includes(toolId)) return;
  const roots = toolId === 'claude' ? [join(sourceId, 'projects')] : [join(sourceId, 'sessions'), join(sourceId, 'archived_sessions')];
  async function walk(dir: string, depth: number): Promise<string | undefined> {
    let files; try { files = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const file of files) {
      if (file.isFile() && (file.name === `${nativeId}.jsonl` || file.name.endsWith(`-${nativeId}.jsonl`))) return join(dir, file.name);
      if (file.isDirectory() && depth < 4) { const found = await walk(join(dir, file.name), depth + 1); if (found) return found; }
    }
  }
  for (const root of roots) { const path = await walk(root, 0); if (path) return path; }
}
export function nativeSessionOperations(tool: Pick<AgentTool, 'id' | 'sourceId' | 'agent'>): ToolSessionOperations {
  return {
    historyMode: 'file',
    historyPath: id => findNativeHistory(tool.id, tool.sourceId, id),
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
export function sessionOperations(tool: AgentTool): ToolSessionOperations { return tool.sessions ?? nativeSessionOperations(tool); }
