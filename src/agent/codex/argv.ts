import type { SandboxMode } from '../../config/profile-schema';
import { buildNativeQueueArgs } from '../../../packages/codex-core/src/queue';

export interface BuildCodexQueueArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId: string;
  prompt: string;
  /** Optional shared app-server endpoint, for example unix://. */
  remote?: string;
  images?: readonly string[];
  model?: string;
  reasoningEffort?: string;
}

/**
 * Queue follow-up input through Codex's native per-thread queue. Unlike
 * `exec resume`, this does not try to acquire the thread writer lock, so it
 * can target a conversation that is currently owned by Codex Desktop.
 */
export function buildCodexQueueArgs(input: BuildCodexQueueArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  return buildNativeQueueArgs(input);
}
