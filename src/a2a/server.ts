import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AuxiliaryGroups } from '../bot/auxiliary-groups';
import type { AuxiliaryApproval, AuxiliaryApprovals } from '../bot/auxiliary-approvals';
import { log } from '../core/logger';
import { authenticate, defaultAlias, endpointForAlias, loadA2AConfig, type A2AConfig, type ApiKey } from './config';
import { A2ATaskStore, taskSnapshot, terminal, type ApiTask, type TaskState } from './store';

export interface TaskExecutionContext {
  closing(): boolean;
  valid(): Promise<boolean>;
  working(): Promise<void>;
  progress(text: string): Promise<void>;
  onStop(stop: () => Promise<void>): void;
}
export interface A2AServerDeps {
  configPath: string;
  tasksPath: string;
  auxiliary: AuxiliaryGroups;
  approvals: AuxiliaryApprovals;
  ownerId(): string | undefined;
  execute(task: ApiTask, context: TaskExecutionContext, approval?: AuxiliaryApproval): Promise<{ state: TaskState; text: string; notice?: string }>;
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason = 'INVALID_ARGUMENT') { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function startA2AServer(deps: A2AServerDeps) {
  const config = await loadA2AConfig(deps.configPath);
  if (!config?.enabled) return;
  const store = new A2ATaskStore(deps.tasksPath); await store.load();
  const stops = new Map<string, () => Promise<void>>();
  const executions = new Map<string, Promise<void>>();
  let closing = false;
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  async function currentConfig(): Promise<A2AConfig> {
    const current = await loadA2AConfig(deps.configPath);
    if (!current?.enabled) throw new ApiError(403, '接口已关闭', 'PERMISSION_DENIED');
    if (current.host !== config!.host || current.port !== config!.port || current.namespace !== config!.namespace) throw new ApiError(503, '监听配置已变更，需重启桥接后使用', 'UNAVAILABLE');
    return current;
  }
  async function valid(task: ApiTask): Promise<boolean> {
    if (closing || terminal(task.state)) return false;
    try {
      const c = await currentConfig(), e = c.endpoints[task.sharedScope], owner = deps.ownerId();
      const key = e?.keys.find(k => k.id === task.keyId && !k.revoked && k.ownerId === owner);
      return !!(e?.enabled && owner === task.ownerId && key && deps.auxiliary.apiSession(task.sharedScope) && deps.auxiliary.isActive(task.scope) &&
        task.actorId === (key.role === 'owner' ? owner : `api_${key.id}`));
    } catch { return false; }
  }
  async function reconcile(task: ApiTask): Promise<void> {
    if (terminal(task.state)) return;
    if (!await valid(task)) {
      await store.update(task, { state: 'TASK_STATE_REJECTED', notice: '入口、密钥或会话已失效，后续步骤已停止。' });
      await deps.auxiliary.cancelApi(task.scope); await stops.get(task.id)?.(); return;
    }
    if (task.state === 'TASK_STATE_AUTH_REQUIRED') {
      const status = deps.approvals.apiStatus(task.scope);
      if (['denied', 'expired', 'stale', 'unknown'].includes(status ?? '')) await store.update(task, {
        state: status === 'unknown' ? 'TASK_STATE_FAILED' : 'TASK_STATE_REJECTED', notice: status === 'denied' ? '所有者已拒绝，本次受限操作未执行。' : '确认已失效或继续状态不明，未自动重新执行。',
      });
    }
  }
  function launch(task: ApiTask, approval?: AuxiliaryApproval): void {
    const attempt = approval?.id ?? 'initial', key = `${task.id}:${attempt}`;
    if (executions.has(key) || closing) return;
    const work = Promise.resolve().then(async () => {
      if (!await valid(task)) { await reconcile(task); return; }
      let lastSave = 0;
      const result = await deps.execute(task, {
        closing: () => closing,
        valid: () => valid(task),
        working: async () => { if (await valid(task)) await store.update(task, { state: 'TASK_STATE_WORKING', notice: undefined }); },
        progress: async text => {
          if (Buffer.byteLength(text) > 1_000_000) throw new Error('本次输出超过 1MB 限制，请缩小任务范围');
          if (Date.now() - lastSave < 300) return;
          lastSave = Date.now();
          if (!await valid(task)) { await reconcile(task); return; }
          if (task.continuationIds.at(-1) !== approval?.id) return;
          await store.update(task, { text });
        },
        onStop: stop => { stops.set(task.id, stop); if (!closing && terminal(task.state)) void stop().catch(() => {}); },
      }, approval);
      if (!terminal(task.state) && !closing && task.continuationIds.at(-1) === approval?.id) await store.update(task, result);
    }).catch(async error => {
      log.warn('a2a', 'task-failed', { taskId: task.id, error: String(error) });
      if (!terminal(task.state) && !closing) await store.update(task, { state: 'TASK_STATE_FAILED', notice: '执行失败或接收未确认；未自动重新执行，请检查已有操作。' });
    }).finally(() => { executions.delete(key); if (![...executions.keys()].some(k => k.startsWith(`${task.id}:`))) stops.delete(task.id); });
    executions.set(key, work);
    void work.catch(error => log.warn('a2a', 'persistence-failed', { taskId: task.id, error: String(error) }));
  }
  async function resume(approval: AuxiliaryApproval): Promise<void> {
    await exclusive(async () => {
      const task = store.list().find(t => t.scope === approval.scope);
      if (!task || !await valid(task)) throw new Error('API 任务或访问授权已失效');
      if (task.continuationIds.includes(approval.id)) return;
      // Claim before execution. Ambiguous restarts never automatically run the action again.
      await store.update(task, { continuationIds: [...task.continuationIds, approval.id], state: 'TASK_STATE_SUBMITTED', notice: '所有者已同意，等待继续执行。' });
      launch(task, approval);
    });
  }
  async function submit(scope: string, key: ApiKey, body: unknown): Promise<{ task: ApiTask; historyLength: number; returnImmediately: boolean }> {
    const input = parseSend(body);
    return exclusive(async () => {
      const owner = deps.ownerId();
      if (!owner || key.ownerId !== owner) throw new ApiError(403, '所有者身份已变化', 'PERMISSION_DENIED');
      const contextId = `ctx_${digest([scope, key.id, owner]).slice(0, 32)}`;
      if (input.contextId && input.contextId !== contextId) throw new ApiError(400, 'contextId 不属于当前接口和密钥');
      const fingerprint = digest([input.question, input.contextId ?? contextId]);
      const previous = store.list().find(t => t.sharedScope === scope && t.keyId === key.id && t.messageId === input.messageId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiError(409, '同一 messageId 的任务内容已变化，不会重复执行', 'ALREADY_EXISTS');
        return { ...input, task: previous };
      }
      if (store.list().filter(t => !terminal(t.state)).length >= 32 || store.list().filter(t => t.keyId === key.id && !terminal(t.state)).length >= 4)
        throw new ApiError(429, '待处理任务已达上限，请查询已有任务', 'RESOURCE_EXHAUSTED');
      const task = await store.create({ sharedScope: scope, keyId: key.id, ownerId: owner,
        actorId: key.role === 'owner' ? owner : `api_${key.id}`, callerName: key.name, contextId, messageId: input.messageId, question: input.question, fingerprint });
      try { await deps.auxiliary.acceptApi(scope, task.id, task.actorId); }
      catch (error) { await store.update(task, { state: 'TASK_STATE_FAILED', notice: '会话共享入口不可用，本次任务未执行。' }); throw error; }
      launch(task); return { ...input, task };
    });
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) throw new ApiError(503, '服务正在停止', 'UNAVAILABLE');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/([A-Za-z0-9_-]+)\/agents\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (!match || match[1] !== config!.namespace) throw new ApiError(404, '接口不存在', 'NOT_FOUND');
    const current = await currentConfig(), target = endpointForAlias(current, match[2]!);
    if (!target || !target[1].enabled) throw new ApiError(404, '接口不存在或已关闭', 'NOT_FOUND');
    const [scope, endpoint] = target, owner = deps.ownerId();
    const key = owner ? authenticate(endpoint, req.headers.authorization, owner) : undefined;
    if (!key) throw new ApiError(401, '需要有效的访问密钥', 'UNAUTHENTICATED');
    const session = deps.auxiliary.apiSession(scope);
    if (!session) throw new ApiError(410, '共享会话已归档或不可用', 'NOT_FOUND');
    const path = match[3] ?? '/';
    if (req.method === 'GET' && ['/agent-card.json', '/.well-known/agent-card.json'].includes(path))
      return reply(res, 200, agentCard(config!, scope, endpoint.alias, session.name));
    if (req.headers['a2a-version'] !== '1.0') throw new ApiError(400, '请发送 A2A-Version: 1.0；不支持自动回退到旧版协议', 'VERSION_NOT_SUPPORTED');
    const historyLength = intQuery(url, 'historyLength', 0, 100);
    if (req.method === 'POST' && path === '/message:send') {
      const accepted = await submit(scope, key, await readJson(req));
      if (!accepted.returnImmediately) {
        while (!terminal(accepted.task.state) && accepted.task.state !== 'TASK_STATE_AUTH_REQUIRED' && !res.destroyed && !closing) await sleep(200);
      }
      return reply(res, 200, { task: taskSnapshot(accepted.task, accepted.historyLength) });
    }
    if (req.method === 'GET' && path === '/tasks') {
      const pageSize = intQuery(url, 'pageSize', 50, 100), pageToken = url.searchParams.get('pageToken');
      if (pageSize < 1) throw new ApiError(400, 'pageSize 须大于 0');
      const filter = { contextId: url.searchParams.get('contextId'), status: url.searchParams.get('status') };
      if (filter.status && !['TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(filter.status)) throw new ApiError(400, 'status 无效');
      const after = url.searchParams.get('statusTimestampAfter');
      if (after && !Number.isFinite(Date.parse(after))) throw new ApiError(400, 'statusTimestampAfter 无效');
      const all = store.list().filter(t => t.sharedScope === scope && t.keyId === key.id && (!filter.contextId || t.contextId === filter.contextId));
      for (const task of all) await reconcile(task);
      const rows = all.filter(t => (!filter.status || filter.status === 'TASK_STATE_UNSPECIFIED' || t.state === filter.status) && (!after || t.updatedAt >= Date.parse(after))).sort((a, b) => a.id.localeCompare(b.id));
      const start = pageToken ? rows.findIndex(t => t.id === pageToken) + 1 : 0;
      if (pageToken && start === 0) throw new ApiError(400, 'pageToken 无效');
      const page = rows.slice(start, start + pageSize);
      const includeArtifacts = url.searchParams.get('includeArtifacts') === 'true';
      return reply(res, 200, { tasks: page.map(t => taskSnapshot(t, historyLength, includeArtifacts)),
        pageSize, totalSize: rows.length, nextPageToken: start + pageSize < rows.length ? page.at(-1)!.id : '' });
    }
    const taskPath = /^\/tasks\/([\da-f-]{36})(:cancel)?$/.exec(path);
    if (taskPath) {
      const task = store.get(taskPath[1]!);
      if (!task || task.sharedScope !== scope || task.keyId !== key.id || task.ownerId !== owner) throw new ApiError(404, '任务不存在或无权访问', 'TASK_NOT_FOUND');
      await reconcile(task);
      if (req.method === 'GET' && !taskPath[2]) return reply(res, 200, taskSnapshot(task, historyLength));
      if (req.method === 'POST' && taskPath[2]) {
        if (terminal(task.state) && task.state !== 'TASK_STATE_CANCELED') throw new ApiError(400, '任务已结束，无法取消', 'TASK_NOT_CANCELABLE');
        if (task.state !== 'TASK_STATE_CANCELED') {
          await store.update(task, { state: 'TASK_STATE_CANCELED', notice: '已取消待处理步骤，并请求停止本次运行；已完成操作不会回滚。' });
          await deps.auxiliary.cancelApi(task.scope); await stops.get(task.id)?.();
        }
        return reply(res, 200, taskSnapshot(task, historyLength));
      }
    }
    if (/message:stream|:subscribe|pushNotification/.test(path)) throw new ApiError(400, '第一版不支持流式、订阅或推送，请轮询任务', 'UNSUPPORTED_OPERATION');
    throw new ApiError(404, '接口不存在', 'NOT_FOUND');
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      const e = error instanceof ApiError ? error : new ApiError(500, '服务暂时不可用，请查询原任务；不要换编号自动重试', 'INTERNAL');
      if (!(error instanceof ApiError)) log.warn('a2a', 'request-failed', { error: String(error) });
      if (e.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      const status = ({ 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ALREADY_EXISTS', 410: 'NOT_FOUND', 413: 'RESOURCE_EXHAUSTED', 415: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' } as Record<number, string>)[e.status] ?? 'UNKNOWN';
      reply(res, e.status, { error: { code: e.status, status, message: e.message,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: e.reason, domain: 'a2a-protocol.org' }] } });
    });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  const timer = setInterval(() => { for (const task of store.list()) if (!terminal(task.state)) void reconcile(task).catch(error => log.warn('a2a', 'refresh-failed', { taskId: task.id, error: String(error) })); }, 3000);
  timer.unref();
  return {
    store, resume,
    validScope: async (scope: string) => { const task = store.list().find(t => t.scope === scope); return !!task && await valid(task); },
    async close(): Promise<void> {
      closing = true; clearInterval(timer);
      server.close(); server.closeIdleConnections();
      // RunExecutor detaches its observers during bridge disconnect. Never cancel
      // a durable worker/Codex task as a side effect of shutting this HTTP listener.
      await store.flushSnapshot();
    },
  };
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'A2A-Version': '1.0' });
  res.end(JSON.stringify(value));
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError(415, '需要 application/json', 'CONTENT_TYPE_NOT_SUPPORTED');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 256_000) throw new ApiError(413, '请求体过大'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, '无效 JSON'); }
}
function intQuery(url: URL, name: string, fallback: number, max: number): number {
  const value = url.searchParams.get(name); if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw new ApiError(400, `${name} 无效`);
  return Number(value);
}
export function parseSend(value: unknown): { messageId: string; question: string; contextId?: string; returnImmediately: boolean; historyLength: number } {
  const input = value as Record<string, any>;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['message', 'configuration', 'metadata'].includes(k))) throw new ApiError(400, '只接受 A2A SendMessageRequest 文本任务');
  const message = input.message, configuration = input.configuration ?? {};
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(k => !['messageId', 'contextId', 'role', 'parts', 'metadata'].includes(k)) ||
      message.role !== 'ROLE_USER' || typeof message.messageId !== 'string' || !/^[\w-]{1,120}$/.test(message.messageId) || !Array.isArray(message.parts) || !message.parts.length || message.parts.length > 20)
    throw new ApiError(400, '需要唯一 messageId、ROLE_USER 和纯文本 parts；第一版不接受 taskId 续跑、系统消息或工具消息');
  if (message.parts.some((p: any) => !p || typeof p !== 'object' || Object.keys(p).some(k => !['text', 'mediaType', 'metadata'].includes(k)) || typeof p.text !== 'string' || (p.mediaType !== undefined && p.mediaType !== 'text/plain'))) throw new ApiError(400, '只支持 text part', 'CONTENT_TYPE_NOT_SUPPORTED');
  const question = message.parts.map((p: { text: string }) => p.text).join('\n');
  if (!question.trim() || question.length > 50_000) throw new ApiError(400, '任务内容需要 1–50000 字符');
  if (typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).some(k => !['returnImmediately', 'acceptedOutputModes', 'historyLength'].includes(k)) ||
      (configuration.returnImmediately !== undefined && typeof configuration.returnImmediately !== 'boolean') ||
      (configuration.acceptedOutputModes !== undefined && (!Array.isArray(configuration.acceptedOutputModes) || (configuration.acceptedOutputModes.length > 0 && !configuration.acceptedOutputModes.includes('text/plain'))))) throw new ApiError(400, '只支持文本结果、returnImmediately 和 historyLength', 'UNSUPPORTED_OPERATION');
  const historyLength = configuration.historyLength ?? 0;
  if (!Number.isInteger(historyLength) || historyLength < 0 || historyLength > 100 || (message.contextId !== undefined && typeof message.contextId !== 'string')) throw new ApiError(400, 'historyLength 或 contextId 无效');
  return { messageId: message.messageId, question, contextId: message.contextId, returnImmediately: configuration.returnImmediately === true, historyLength };
}
export function agentCard(config: A2AConfig, scope: string, alias: string | undefined, name: string) {
  const base = `http://${config.host}:${config.port}/${config.namespace}/agents/${defaultAlias(scope)}`;
  return { name, description: '通过会话共享提供项目上下文的AI助手，可问答和执行调试检查。每条消息只提交一个明确任务；勿作为通用模型供应商配置，勿上传完整对话或自动重复执行。权限确认由服务端联系所有者，等待期间继续查询原任务。',
    version: '1.0.0', supportedInterfaces: [{ url: base, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false,
      extensions: [{ uri: 'https://github.com/cvster/CodexFeishu/blob/main/docs/A2A_API.md#project-assistant-v1',
        description: '共享AI助手及完整任务快照', required: false,
        params: { aliases: [defaultAlias(scope), ...(alias ? [alias] : [])], sharedContext: true, partialArtifacts: true, pollIntervalMs: 1000 } }] },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'project-assistant', name: '项目问答与调试检查', description: '提交文本任务，使用 returnImmediately=true 后查询完整任务快照。每次使用唯一 messageId，同编号相同内容去重。API 过程和结果不发送到群。', tags: ['project', 'debugging'] }],
  };
}
