import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobSnapshot, WorkerEndpoint, WorkerJob, WorkerSubmission } from './protocol';

export class WorkerRequestError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}
export class WorkerClient {
  constructor(readonly stateDir: string, readonly sourceId: string, readonly botAppId: string, readonly toolId = 'claude') {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const endpoint = JSON.parse(await readFile(join(this.stateDir, 'endpoint.json'), 'utf8')) as WorkerEndpoint;
    if (endpoint.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || typeof endpoint.token !== 'string') throw new Error('Invalid worker endpoint');
    const result = await fetch(`${endpoint.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const value = await result.json();
    if (!result.ok) throw new WorkerRequestError(result.status, (value as { error: string }).error, (value as { retryable?: boolean }).retryable === true);
    return value as T;
  }
  async health(): Promise<{ nativeReasoningEfforts?: boolean }> {
    const value = await this.request<{ version: number; toolId: string; sourceId: string; botAppId: string; nativeReasoningEfforts?: boolean }>('/health');
    if (value.version !== 1 || value.toolId !== this.toolId || value.sourceId !== this.sourceId || value.botAppId !== this.botAppId) throw new Error('执行服务的工具、账户目录或飞书应用不匹配');
    return { nativeReasoningEfforts: value.nativeReasoningEfforts };
  }
  async list(): Promise<WorkerJob[]> { await this.health(); return this.request('/jobs'); }
  async submit(input: WorkerSubmission): Promise<WorkerJob> { await this.health(); return this.request('/jobs', input); }
  async snapshot(id: string, after = 0): Promise<JobSnapshot> { return this.request(`/jobs/${id}?after=${after}`); }
  async stop(id: string): Promise<void> { await this.request(`/jobs/${id}/stop`, {}); }
}
