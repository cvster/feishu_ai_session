import { CodexThreadReader, type CodexThreadReaderOptions } from '../../session/codex-thread-reader';
import { resolveSharedCodexEndpoint } from '../../../packages/codex-core/src/queue';
import type { ModelOption } from '../models';

export async function readCodexModels(reader: Pick<CodexThreadReader, 'rpc'>): Promise<ModelOption[]> {
  const models: ModelOption[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await reader.rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error('Codex 模型列表格式不兼容');
    for (const row of result.data as any[]) if (!row.hidden) models.push({ value: row.model ?? row.id, label: row.displayName ?? row.model ?? row.id });
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Codex 模型列表分页游标重复');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}
export async function listCodexModels(options: CodexThreadReaderOptions): Promise<ModelOption[]> {
  const remote = await resolveSharedCodexEndpoint({ codexHome: options.codexHome, remote: options.remote });
  const reader = new CodexThreadReader({ ...options, passive: true, timeoutMs: 10_000, ...(remote ? { sharedServer: true, remote } : {}) });
  try { return await readCodexModels(reader); } finally { await reader.stop(); }
}
