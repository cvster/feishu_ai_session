import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobSnapshot, WorkerCapabilities, WorkerEndpoint, WorkerErrorCode, WorkerHealth, WorkerJob, WorkerSessionHistory, WorkerSubmission } from './protocol';
import type { ToolSession } from '../tools/types';

type HealthDetails = Omit<WorkerHealth, 'version' | 'toolId' | 'sourceId' | 'botAppId'>;

export class WorkerRequestError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false, readonly code?: WorkerErrorCode) { super(message); }
}
export class WorkerClient {
  constructor(readonly stateDir: string, readonly sourceId: string, readonly botAppId: string, readonly toolId = 'claude') {}
  private async request<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const endpoint = JSON.parse(await readFile(join(this.stateDir, 'endpoint.json'), 'utf8')) as WorkerEndpoint;
    if (endpoint.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || typeof endpoint.token !== 'string') throw new Error('Invalid worker endpoint');
    const result = await fetch(`${endpoint.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const value = await result.json();
    if (!result.ok) throw new WorkerRequestError(result.status, (value as { error: string }).error, (value as { retryable?: boolean }).retryable === true, (value as { code?: WorkerErrorCode }).code);
    return value as T;
  }
  async health(): Promise<HealthDetails> {
    const value = await this.request<WorkerHealth>('/health');
    if (value.version !== 1 || value.toolId !== this.toolId || value.sourceId !== this.sourceId || value.botAppId !== this.botAppId) throw new Error('执行服务的工具、账户目录或飞书应用不匹配');
    const { version: _version, toolId: _toolId, sourceId: _sourceId, botAppId: _botAppId, ...details } = value;
    return details;
  }
  async capabilities(): Promise<WorkerCapabilities | undefined> { return (await this.health()).capabilities; }
  private unsupported(): never { throw new WorkerRequestError(501, 'Worker does not support this operation', false, 'unsupported-operation'); }
  async stopNativeTurn(id: string, turnId: string, cwd: string): Promise<boolean> {
    const health = await this.health();
    const supported = health.capabilities?.nativeTurnStop;
    if (supported === true) return (await this.request<{ stopped: boolean }>(`/sessions/${encodeURIComponent(id)}/turn-stop`, { turnId, cwd }, 60_000)).stopped;
    // Decide compatibility before writing. Never retry an uncertain mutation.
    if (supported === undefined && health.zcodeNativeStop) return (await this.request<{ stopped: boolean }>('/native-turn-stop', { id, turnId, cwd }, 60_000)).stopped;
    throw new WorkerRequestError(501, 'Worker 尚未支持原生任务停止，请单独升级对应 worker', false, 'unsupported-operation');
  }
  async renameSession(id: string, name: string, cwd?: string): Promise<void> {
    const health = await this.health();
    if (health.capabilities?.sessions.rename) {
      await this.request(`/sessions/${encodeURIComponent(id)}/rename`, { name, ...(cwd ? { cwd } : {}) }, 60_000); return;
    }
    if (!health.capabilities && health.zcodeSessionNames && cwd) {
      await this.request('/session-name', { id, name, cwd }, 60_000); return;
    }
    this.unsupported();
  }
  async listSessions(): Promise<ToolSession[]> {
    if (!(await this.capabilities())?.sessions.list) this.unsupported();
    return this.request('/sessions', undefined, 60_000);
  }
  async sessionHistory(id: string): Promise<WorkerSessionHistory> {
    if (!(await this.capabilities())?.sessions.history) this.unsupported();
    return this.request(`/sessions/${encodeURIComponent(id)}/history`, undefined, 60_000);
  }
  async archiveSession(id: string): Promise<void> {
    if (!(await this.capabilities())?.sessions.archive) this.unsupported();
    await this.request(`/sessions/${encodeURIComponent(id)}/archive`, {}, 60_000);
  }
  async forkSession(id: string): Promise<{ nativeId: string; name: string; cwd: string }> {
    if (!(await this.capabilities())?.sessions.fork) this.unsupported();
    return this.request(`/sessions/${encodeURIComponent(id)}/fork`, {}, 60_000);
  }
  async list(): Promise<WorkerJob[]> { await this.health(); return this.request('/jobs'); }
  async models(cwd?: string): Promise<import('../agent/models').ModelOption[]> {
    const health = await this.health();
    if (health.capabilities && !health.capabilities.models) this.unsupported();
    return this.request(`/models?cwd=${encodeURIComponent(cwd ?? '')}`, undefined, 60_000);
  }
  async submit(input: WorkerSubmission): Promise<WorkerJob> { await this.health(); return this.request('/jobs', input); }
  async snapshot(id: string, after = 0): Promise<JobSnapshot> { return this.request(`/jobs/${id}?after=${after}`); }
  async stop(id: string): Promise<void> { await this.request(`/jobs/${id}/stop`, {}); }
}
