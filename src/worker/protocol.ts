import type { AgentBotIdentity, AgentEvent, AgentRunOptions } from '../agent/types';
import type { ToolSession } from '../tools/types';
import type { NativeConversationSnapshot } from '../agent/native-conversation';
import type { CodexInputAnswers, CodexInputRequest } from '../session/codex-user-input';

/** Transport capabilities, independent of provider-specific compatibility flags. */
export interface WorkerCapabilities {
  apiVersion: 2;
  jobs: { submit: true; read: true; stop: true; eventCursor: true };
  models: boolean;
  reasoningMapping?: boolean;
  sessions: { list: boolean; history: boolean; rename: boolean; archive: boolean; fork: boolean; archiveEffect?: 'delete' };
  nativeTurnStop: boolean;
  conversation?: boolean;
  questions?: boolean;
  nativeSessionNames?: boolean;
  /** Successful list is the complete set accepted by this worker's current configuration. */
  sessionListAuthoritative?: boolean;
}
export interface WorkerManifest {
  label: string;
  nativeField: 'sessionId' | 'threadId';
  sessionKind: string;
  historyFormat: 'json' | 'jsonl';
  nativeHistory: boolean;
}
export interface WorkerQuestion { id: string; request: CodexInputRequest; available: boolean; origin?: 'native' | 'worker' | 'unknown'; delivery?: RunDelivery }
export interface WorkerHealth {
  version: 1;
  toolId: string;
  sourceId: string;
  botAppId: string;
  capabilities?: WorkerCapabilities;
  manifest?: WorkerManifest;
  nativeReasoningEfforts?: boolean;
  zcodeRegistryResume?: boolean;
  zcodeSessionNames?: boolean;
  zcodeNativeStop?: boolean;
  zcodeDesktopRemote?: boolean;
  zcodeDesktopRemoteConfigId?: string;
  kiloEditorSync?: boolean;
  kiloNativeInputOrigin?: boolean;
}
/** History is an export of native records, not the worker job journal. */
export interface WorkerSessionHistory {
  nativeId: string;
  format: 'json' | 'jsonl';
  content: string;
}
export interface WorkerSessionService {
  list(): Promise<ToolSession[]>;
  listAuthoritative?: boolean;
  history(nativeId: string): Promise<WorkerSessionHistory | undefined>;
  rename?(nativeId: string, name: string, cwd?: string): Promise<void>;
  archive?(nativeId: string): Promise<void>;
  archiveEffect?: 'delete';
  fork?(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }>;
  conversation?(nativeId: string): Promise<NativeConversationSnapshot>;
  questions?(nativeId: string): Promise<WorkerQuestion[]>;
  answer?(nativeId: string, questionId: string, answers: CodexInputAnswers): Promise<boolean>;
  close?(): Promise<void>;
  nativeNames?: boolean;
  receiveInput?(prompt: import('../session/codex-user-input').CodexInputPrompt): void;
  /** Synchronous observation of a native blocking prompt; never submits input. */
  waitingForInput?(nativeId: string): boolean;
}
export type WorkerErrorCode = 'invalid-request' | 'unauthorized' | 'not-found' | 'unsupported-operation' | 'busy' | 'conflict' | 'unavailable' | 'internal-error';

export interface RunDelivery {
  scope: string;
  chatId: string;
  replyTo: string;
  replyInThread?: boolean;
  operatorOpenId: string;
  policyFingerprint: string;
  botAppId: string;
  sourceId: string;
  messageIds?: string[];
}

export interface WorkerSubmission {
  requestKey: string;
  options: AgentRunOptions;
  botIdentity?: AgentBotIdentity;
}

export type JobStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface WorkerJob extends WorkerSubmission {
  version: 1;
  id: string;
  fingerprint: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export interface StoredEvent { seq: number; at: number; event: AgentEvent }
export interface JobSnapshot { job: WorkerJob; events: StoredEvent[] }
export interface WorkerEndpoint { version: 1; url: string; token: string; pid: number }
export const isJobActive = (job: WorkerJob): boolean => job.status === 'accepted' || job.status === 'running';
