import type { AgentBotIdentity, AgentEvent, AgentRunOptions } from '../agent/types';
import type { ToolSession } from '../tools/types';

/** Transport capabilities, independent of provider-specific compatibility flags. */
export interface WorkerCapabilities {
  apiVersion: 2;
  jobs: { submit: true; read: true; stop: true; eventCursor: true };
  models: boolean;
  sessions: { list: boolean; history: boolean; rename: boolean; archive: boolean; fork: boolean };
  nativeTurnStop: boolean;
}
export interface WorkerHealth {
  version: 1;
  toolId: string;
  sourceId: string;
  botAppId: string;
  capabilities?: WorkerCapabilities;
  nativeReasoningEfforts?: boolean;
  zcodeRegistryResume?: boolean;
  zcodeSessionNames?: boolean;
  zcodeNativeStop?: boolean;
  zcodeDesktopRemote?: boolean;
  zcodeDesktopRemoteConfigId?: string;
  kiloEditorSync?: boolean;
  kiloDesktopSync?: boolean;
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
  history(nativeId: string): Promise<WorkerSessionHistory | undefined>;
  rename?(nativeId: string, name: string, cwd?: string): Promise<void>;
  archive?(nativeId: string): Promise<void>;
  fork?(nativeId: string): Promise<{ nativeId: string; name: string; cwd: string }>;
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
