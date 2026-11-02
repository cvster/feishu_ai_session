import { isAbsolute } from 'node:path';
import type { SessionHistoryPointer } from '../tools/types';
import type { WorkerSessionHistory } from './protocol';
import { log } from '../core/logger';

const MAX_PATH_CHARS = 4096;
const MAX_HINT_CHARS = 2000;
const MAX_HINT_LINES = 24;
/**
 * Text that can reorder or conceal what follows is dropped whole; the bridge never
 * silently cleans a worker answer into something it did not say.
 */
const UNSAFE_HINT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** The path reaches a prompt verbatim, so only a plain absolute path is accepted. */
export function validHistoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS || !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)) return;
  return value;
}
export function validHistoryHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const hint = value.trim();
  if (!hint || [...hint].length > MAX_HINT_CHARS || hint.split('\n').length > MAX_HINT_LINES ||
    UNSAFE_HINT.test(hint) || hint.includes('```')) return;
  return hint;
}

/**
 * A worker answer may be older or poorer than the current protocol: a missing
 * pointer is a degraded answer, never a failed request.
 */
export function historyPointerFrom(value: unknown, nativeId: string): SessionHistoryPointer {
  if (!value || typeof value !== 'object') throw new Error('Invalid worker history');
  const history = value as Partial<WorkerSessionHistory>;
  if (history.nativeId !== nativeId || (history.format !== 'json' && history.format !== 'jsonl'))
    throw new Error('Invalid worker history');
  const path = validHistoryPath(history.path), hint = validHistoryHint(history.hint);
  if ((history.path !== undefined && !path) || (history.hint !== undefined && !hint))
    log.warn('worker', 'history-pointer-dropped', { nativeId, path: path === undefined, hint: hint === undefined });
  return { format: history.format, ...(path ? { path } : {}), ...(hint ? { hint } : {}) };
}
