import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobSnapshot, WorkerCapabilities, WorkerEndpoint, WorkerErrorCode, WorkerHealth, WorkerJob, WorkerManifest, WorkerSessionHistory, WorkerSubmission } from './protocol';
import type { ToolSession } from '../tools/types';

export type HealthDetails = Omit<WorkerHealth, 'version' | 'toolId' | 'sourceId' | 'botAppId'>;
export async function probeWorker(stateDir: string, botAppId: string, timeoutMs = 2000): Promise<WorkerHealth> {
  const endpoint = JSON.parse(await readFile(join(stateDir, 'endpoint.json'), 'utf8')) as WorkerEndpoint;
  if (endpoint.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || typeof endpoint.token !== 'string') throw new Error('Invalid worker endpoint');
  const response = await fetch(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('Worker unavailable');
  const health = await response.json() as WorkerHealth;
  if (!validWorkerHealth(health, botAppId)) throw new Error('Incompatible worker identity or protocol');
  return health;
}

export function validWorkerHealth(value: unknown, botAppId: string): value is WorkerHealth {
  if (!value || typeof value !== 'object') return false;
  const h = value as WorkerHealth, c = h.capabilities, m = h.manifest;
  return h.version === 1 && h.botAppId === botAppId && typeof h.sourceId === 'string' && !!h.sourceId && h.sourceId.length <= 4096 && !/[\u0000-\u001f]/.test(h.sourceId) &&
    typeof h.toolId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(h.toolId) && !!c && c.apiVersion === 2 &&
    !!c.jobs && ['submit', 'read', 'stop', 'eventCursor'].every(key => c.jobs[key as keyof typeof c.jobs] === true) &&
    typeof c.models === 'boolean' && typeof c.nativeTurnStop === 'boolean' && !!c.sessions &&
    ['list', 'history', 'rename', 'archive', 'fork'].every(key => typeof c.sessions[key as keyof typeof c.sessions] === 'boolean') &&
    ['conversation', 'questions', 'nativeSessionNames', 'sessionListAuthoritative'].every(key => c[key as 'conversation'] === undefined || typeof c[key as 'conversation'] === 'boolean') &&
    !!m && typeof m.label === 'string' && !!m.label.trim() && m.label.length <= 100 && !/[\u0000-\u001f]/.test(m.label) &&
    ['threadId', 'sessionId'].includes(m.nativeField) && typeof m.sessionKind === 'string' && !!m.sessionKind.trim() && m.sessionKind.length <= 100 &&
    ['json', 'jsonl'].includes(m.historyFormat) && typeof m.nativeHistory === 'boolean';
}

export class WorkerRequestError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false, readonly code?: WorkerErrorCode) { super(message); }
}
export class WorkerClient {
  private sessionRoster?: { at: number; ids: Set<string> };
  private rosterLoading?: Promise<ToolSession[]>;
  constructor(readonly stateDir: string, readonly sourceId: string, readonly botAppId: string, readonly toolId = 'claude',
    private readonly expectedManifest?: Pick<WorkerManifest, 'nativeField' | 'sessionKind'>) {}
  private matchesIdentity(value: WorkerHealth | undefined): value is WorkerHealth {
    return !!value && value.version === 1 && value.toolId === this.toolId &&
      (!this.sourceId || value.sourceId === this.sourceId) && value.botAppId === this.botAppId &&
      (!this.expectedManifest || (validWorkerHealth(value, this.botAppId) &&
        value.manifest!.nativeField === this.expectedManifest.nativeField &&
        value.manifest!.sessionKind === this.expectedManifest.sessionKind));
  }
  private async request<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const endpoint = JSON.parse(await readFile(join(this.stateDir, 'endpoint.json'), 'utf8')) as WorkerEndpoint;
    if (endpoint.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || typeof endpoint.token !== 'string') throw new Error('Invalid worker endpoint');
    if (path !== '/health') {
      const identity = await fetch(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(2000) });
      const value = identity.ok ? await identity.json() as WorkerHealth : undefined;
      if (!this.matchesIdentity(value)) throw new Error('Worker identity changed or unavailable');
    }
    const result = await fetch(`${endpoint.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const value = await result.json();
    if (!result.ok) throw new WorkerRequestError(result.status, (value as { error: string }).error, (value as { retryable?: boolean }).retryable === true, (value as { code?: WorkerErrorCode }).code);
    return value as T;
  }
  async health(): Promise<HealthDetails> {
    const value = await this.request<WorkerHealth>('/health');
    if (!this.matchesIdentity(value)) throw new Error('执行服务的工具、账户目录、会话格式或飞书应用不匹配');
    const { version: _version, toolId: _toolId, sourceId: _sourceId, botAppId: _botAppId, ...details } = value;
    return details;
  }
  async capabilities(): Promise<WorkerCapabilities | undefined> { return (await this.health()).capabilities; }
  private unsupported(): never { throw new WorkerRequestError(501, 'Worker does not support this operation', false, 'unsupported-operation'); }
  async stopNativeTurn(id: string, turnId: string, cwd: string): Promise<boolean> {
    const health = await this.health();
    const supported = health.capabilities?.nativeTurnStop;
    if (supported === true) return (await this.request<{ stopped: boolean }>(`/sessions/${encodeURIComponent(id)}/turn-stop`, { turnId, cwd }, 60_000)).stopped;
    throw new WorkerRequestError(501, 'Worker 尚未支持原生任务停止，请单独升级对应 worker', false, 'unsupported-operation');
  }
  async renameSession(id: string, name: string, cwd?: string): Promise<void> {
    const health = await this.health();
    if (health.capabilities?.sessions.rename) {
      await this.request(`/sessions/${encodeURIComponent(id)}/rename`, { name, ...(cwd ? { cwd } : {}) }, 60_000); return;
    }
    this.unsupported();
  }
  async listSessions(): Promise<ToolSession[]> {
    if (!(await this.capabilities())?.sessions.list) this.unsupported();
    return this.rosterLoading ??= this.request<ToolSession[]>('/sessions', undefined, 60_000).then(rows => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.nativeId !== 'string')) throw new Error('Invalid worker session list');
      this.sessionRoster = { at: Date.now(), ids: new Set(rows.map(row => row.nativeId)) }; return rows;
    }).finally(() => { this.rosterLoading = undefined; });
  }
  async sessionAvailable(id: string): Promise<boolean> {
    if (!(await this.capabilities())?.sessionListAuthoritative) return true;
    if (!this.sessionRoster || Date.now() - this.sessionRoster.at >= 15_000) await this.listSessions();
    return this.sessionRoster!.ids.has(id);
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
  async conversation(id: string): Promise<import('../agent/native-conversation').NativeConversationSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(id)}/conversation`, undefined, 60_000);
  }
  async questions(id: string): Promise<import('./protocol').WorkerQuestion[]> {
    return this.request(`/sessions/${encodeURIComponent(id)}/questions`, undefined, 60_000);
  }
  async answer(id: string, questionId: string, answers: import('../session/codex-user-input').CodexInputAnswers): Promise<boolean> {
    return (await this.request<{ accepted: boolean }>(`/sessions/${encodeURIComponent(id)}/answer`, { questionId, answers }, 60_000)).accepted;
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
