import type { AgentBotIdentity, AgentEvent, AgentRunOptions } from '../agent/types';

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
