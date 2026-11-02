import { lstat } from 'node:fs/promises';
import type { ToolSessionOperations } from '../tools/types';
import type { WorkerSessionHistory } from './protocol';
import { log } from '../core/logger';

/**
 * Report where the native records are; the records themselves never cross this
 * transport. A session with no readable file still answers with a hint so the
 * bridge always has something to hand the model.
 */
export async function exportWorkerHistory(provider: ToolSessionOperations, nativeId: string): Promise<WorkerSessionHistory | undefined> {
  const format = provider.historyMode === 'snapshot' ? 'json' : 'jsonl';
  const hint = provider.historyHint?.(nativeId);
  const path = await provider.historyPath(nativeId).catch((error) => {
    // Provider export failures are diagnostics, not request failures: report the
    // hint instead of turning an oversized or unreadable session into an error.
    log.warn('worker', 'history-export-failed', { nativeId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  // lstat never follows a link, so a symlink is reported without a path.
  const info = path ? await lstat(path).catch(() => undefined) : undefined;
  const usable = info?.isFile() ? path : undefined;
  if (!usable && !hint) return;
  return { nativeId, format, ...(usable ? { path: usable } : {}), ...(hint ? { hint } : {}) };
}
