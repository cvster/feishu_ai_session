import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ToolSessionOperations } from '../tools/types';
import type { WorkerSessionHistory } from './protocol';
import { WorkerApiError } from './tool-api';

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** Export records across the transport, never an arbitrary caller-supplied file path. */
export async function exportWorkerHistory(provider: ToolSessionOperations, nativeId: string): Promise<WorkerSessionHistory | undefined> {
  const path = await provider.historyPath(nativeId);
  if (!path) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) throw new WorkerApiError(413, 'Session history is too large', 'invalid-request');
    // Snapshot the bounded prefix even when native JSONL is still being appended.
    const bytes = Buffer.alloc(stat.size);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (provider.historyMode !== 'snapshot' && length && bytes[length - 1] !== 10) length = bytes.lastIndexOf(10, length - 1) + 1;
    const content = bytes.subarray(0, length).toString('utf8');
    return { nativeId, format: provider.historyMode === 'snapshot' ? 'json' : 'jsonl', content };
  } finally { await file.close(); }
}
