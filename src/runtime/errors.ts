import type { AgentPreflightDiagnostic, AgentPreflightErrorCode } from '../agent/preflight';

export type RunRejectedCode =
  | 'model-unavailable'
  | 'session-archived'
  | 'archive-check-unavailable'
  | 'pool-full'
  | 'policy-expired'
  | 'reconnect-in-progress'
  | 'run-already-active'
  | 'native-session-busy'
  | 'execution-worker-unavailable';
export type SpawnFailedCode =
  | 'agent-spawn-failed'
  | 'agent-prepare-failed'
  | AgentPreflightErrorCode;

export class RunRejected extends Error {
  readonly code: RunRejectedCode;

  constructor(code: RunRejectedCode, message: string, readonly retryable =
    ['pool-full', 'reconnect-in-progress', 'run-already-active', 'native-session-busy', 'execution-worker-unavailable'].includes(code)) {
    super(message);
    this.name = 'RunRejected';
    this.code = code;
  }
}

export class SpawnFailed extends Error {
  override readonly cause: unknown;
  readonly code: SpawnFailedCode;
  readonly diagnostic: AgentPreflightDiagnostic | undefined;

  constructor(
    message: string,
    cause: unknown,
    code: SpawnFailedCode = 'agent-spawn-failed',
    diagnostic?: AgentPreflightDiagnostic,
  ) {
    super(message);
    this.name = 'SpawnFailed';
    this.cause = cause;
    this.code = code;
    this.diagnostic = diagnostic;
  }
}
