import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type TaskState = 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED' | 'TASK_STATE_REJECTED' | 'TASK_STATE_AUTH_REQUIRED';
export interface ApiTask {
  id: string;
  contextId: string;
  sharedScope: string;
  keyId: string;
  ownerId: string;
  actorId: string;
  callerName: string;
  scope: string;
  messageId: string;
  question: string;
  fingerprint: string;
  state: TaskState;
  text: string;
  notice?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Approval receipts are durably claimed before any continuation starts. */
  continuationIds: string[];
}
export function terminal(state: TaskState): boolean { return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state); }
export class A2ATaskStore {
  private rows: Record<string, ApiTask> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== 1 || !raw.tasks || Array.isArray(raw.tasks)) throw new Error('Invalid A2A task ledger');
      for (const [id, r] of Object.entries(raw.tasks) as [string, ApiTask][]) {
        if (id !== r.id || !r.scope.startsWith('a2a_') || !r.sharedScope || !r.keyId || !r.ownerId || !r.messageId || typeof r.question !== 'string' || typeof r.text !== 'string' || !Array.isArray(r.continuationIds) ||
            !['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'].includes(r.state)) throw new Error('Invalid A2A task');
        // A process may have exited on either side of model acceptance. Never rerun.
        if (['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(r.state)) {
          r.state = 'TASK_STATE_FAILED'; r.notice = '桥接曾退出，执行结果未确认；未自动重新执行，请先检查已产生的操作。'; r.updatedAt = Date.now(); r.revision++;
        }
      }
      this.rows = raw.tasks; await this.flushSnapshot();
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  get(id: string): ApiTask | undefined { return this.rows[id]; }
  list(): ApiTask[] { return Object.values(this.rows); }
  async create(input: Omit<ApiTask, 'id' | 'scope' | 'state' | 'text' | 'revision' | 'createdAt' | 'updatedAt' | 'continuationIds'>): Promise<ApiTask> {
    const id = randomUUID(), now = Date.now();
    const task: ApiTask = { ...input, id, scope: `a2a_${id}`, state: 'TASK_STATE_SUBMITTED', text: '', revision: 1, createdAt: now, updatedAt: now, continuationIds: [] };
    this.rows[id] = task;
    try { await this.flushSnapshot(); } catch (error) { delete this.rows[id]; throw error; }
    return task;
  }
  async update(task: ApiTask, patch: Partial<Pick<ApiTask, 'state' | 'text' | 'notice' | 'continuationIds'>>): Promise<void> {
    Object.assign(task, patch, { revision: task.revision + 1, updatedAt: Date.now() });
    await this.flushSnapshot();
  }
  async flushSnapshot(): Promise<void> {
    const text = JSON.stringify({ version: 1, tasks: this.rows }) + '\n';
    this.writes = this.writes.catch(() => {}).then(() => writeFileAtomic(this.path, text, { mode: 0o600 }));
    await this.writes;
  }
}
export function taskSnapshot(task: ApiTask, historyLength = 0, includeArtifacts = true) {
  return { id: task.id, contextId: task.contextId,
    status: { state: task.state, timestamp: new Date(task.updatedAt).toISOString(),
      ...(task.notice ? { message: { messageId: `status-${task.id}-${task.revision}`, contextId: task.contextId, taskId: task.id, role: 'ROLE_AGENT', parts: [{ text: task.notice }] } } : {}) },
    ...(includeArtifacts ? { artifacts: task.text ? [{ artifactId: `answer-${task.id}`, name: 'answer', parts: [{ text: task.text }] }] : [] } : {}),
    ...(historyLength > 0 ? { history: [{ messageId: task.messageId, contextId: task.contextId, taskId: task.id, role: 'ROLE_USER', parts: [{ text: task.question }] }] } : {}),
    metadata: { revision: task.revision },
  };
}
