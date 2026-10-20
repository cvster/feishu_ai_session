import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';
import type { CodexInputPrompt, CodexRequestId } from '../session/codex-user-input';
import type { RunDelivery } from '../worker/protocol';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'user_input'; prompt: CodexInputPrompt }
  | { type: 'user_input_resolved'; threadId: string; requestId: CodexRequestId }
  | { type: 'system'; sessionId?: string; threadId?: string; turnId?: string; cwd?: string; model?: string; reasoningEffort?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout'; submissionStatus?: 'rejected' | 'unknown'; retryable?: boolean };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  sessionName?: string;
  initialSessionId?: string;
  requestKey?: string;
  delivery?: RunDelivery;
  idleTimeoutMs?: number;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  images?: readonly string[];
  /** All accepted local attachments; submission must not silently lose files. */
  attachmentPaths?: readonly string[];
  accessMode?: import('../config/permissions').AccessMode;
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /** Release this observer on bridge shutdown, without cancelling the task. */
  detach?(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Used for structured message context
 * and forwarded by durable adapters as execution metadata.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  /** Read the tool's current catalog without sending user input or running inference. */
  listModels?(options?: { cwd?: string }): Promise<import('./models').ModelOption[]>;
  /** Update native metadata without submitting model input. */
  renameSession?(id: string, name: string, cwd: string): Promise<void>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /** Queue acceptance only; subsequent execution belongs to the shared writer. */
  submit?(opts: AgentRunOptions, beforeSend: (prepared: { threadId: string; knownTurnIds: string[];
    transport: 'rpc' | 'cli' }) => Promise<void>): Promise<AgentSubmissionResult>;
  setThreadName?(threadId: string, name: string): Promise<void>;
  archiveThread?(threadId: string): Promise<void>;
  forkThread?(threadId: string): Promise<{ threadId: string; name: string; cwd: string }>;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that do not need bot identity metadata may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}

/** Queue acceptance contract; threadId is the legacy native-queue wire name. */
export type AgentSubmissionResult = { submissionId: string; threadId: string; transport: 'rpc' | 'cli' } & (
  | { status: 'accepted'; queueId?: string; clientUserMessageId?: string; continuationWarning?: string }
  | { status: 'rejected' | 'unknown'; message: string }
);
