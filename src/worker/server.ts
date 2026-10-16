import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AgentAdapter, AgentRun } from '../agent/types';
import { JobStore, jobIdFor, submissionFingerprint } from './store';
import { isJobActive, type WorkerJob, type WorkerSubmission } from './protocol';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WorkerServerOptions {
  stateDir: string;
  agent: AgentAdapter;
  sourceId: string;
  botAppId: string;
  maxConcurrent?: number;
}
class HttpError extends Error { constructor(readonly status: number, message: string, readonly retryable = status === 429 || status === 503) { super(message); } }

export async function startWorkerServer(options: WorkerServerOptions) {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(options.stateDir, 'worker.lock');
  await writeFile(lockPath, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(lockPath, { realpath: false, stale: 30_000, update: 5_000 });
  const store = new JobStore(join(options.stateDir, 'jobs'));
  try { await store.load(); } catch (error) { await release(); throw error; }
  for (const job of store.list()) if (isJobActive(job)) {
    const terminal = store.snapshot(job.id)?.events.map(row => row.event).reverse().find(event => event.type === 'done' || event.type === 'error');
    if (terminal) {
      await store.put({ ...job, status: terminal.type === 'error' && terminal.submissionStatus === 'unknown' ? 'unknown' : terminal.type === 'done' && terminal.terminationReason === 'normal' ? 'completed' : terminal.terminationReason === 'interrupted' ? 'interrupted' : 'failed', updatedAt: Date.now() });
      continue;
    }
    // A crash may occur on either side of spawn. Never replay an uncertain request.
    await store.append(job.id, { type: 'error', terminationReason: 'failed', message: '执行服务曾退出，任务状态无法确认；未自动重新执行。请检查已产生的操作。' });
    await store.put({ ...job, status: 'unknown', updatedAt: Date.now(), error: 'worker-restarted' });
  }
  const runs = new Map<string, AgentRun>();
  const tasks = new Map<string, Promise<void>>();
  const stopped = new Set<string>();
  const nativeLeases = new Set<string>();
  let closing = false;
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = serial.then(fn); serial = task.catch(() => {}); return task;
  };
  const persistStatus = async (job: WorkerJob, status: WorkerJob['status'], error?: string) =>
    store.put({ ...job, status, updatedAt: Date.now(), ...(error ? { error } : {}) });
  const execute = async (job: WorkerJob): Promise<void> => {
    const native = job.options.sessionId ?? job.options.initialSessionId;
    let run: AgentRun | undefined;
    let terminal = false;
    let status: WorkerJob['status'] = 'failed';
    let lastActivityAt = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let timeout = false;
    try {
      if (stopped.has(job.id)) { status = 'interrupted'; return; }
      await options.agent.prepareRun?.(job.options);
      if (stopped.has(job.id) || closing) { status = 'interrupted'; return; }
      await persistStatus(job, 'running');
      options.agent.setBotIdentity?.(job.botIdentity ?? { openId: '' });
      run = options.agent.run({ ...job.options, runId: job.id }); runs.set(job.id, run);
      if (job.options.idleTimeoutMs) {
        timer = setInterval(() => {
          if (Date.now() - lastActivityAt >= job.options.idleTimeoutMs! && !timeout) {
            timeout = true; void run!.stop().catch(() => {});
          }
        }, Math.min(1000, job.options.idleTimeoutMs));
      }
      for await (const event of run.events) {
        lastActivityAt = Date.now();
        await store.append(job.id, event.type === 'done' && timeout ? { ...event, terminationReason: 'timeout' } : event);
        if (event.type === 'done' || event.type === 'error') {
          terminal = true;
          status = event.type === 'error' && event.submissionStatus === 'unknown' ? 'unknown' : event.type === 'done' && event.terminationReason === 'normal' ? 'completed' :
            event.terminationReason === 'interrupted' || stopped.has(job.id) ? 'interrupted' : 'failed';
          if (timer) { clearInterval(timer); timer = undefined; }
        }
      }
      if (!await run.waitForExit(5000)) await run.stop();
      if (!terminal && (stopped.has(job.id) || timeout)) status = 'interrupted';
    } catch (error) {
      terminal = true;
      status = stopped.has(job.id) || timeout ? 'interrupted' : 'failed';
      await store.append(job.id, { type: 'error', terminationReason: timeout ? 'timeout' : stopped.has(job.id) ? 'interrupted' : 'failed', message: error instanceof Error ? error.message : String(error) });
      if (run) await run.stop().catch(() => {});
    } finally {
      if (timer) clearInterval(timer);
      if (!terminal) await store.append(job.id, status === 'interrupted' || stopped.has(job.id) || timeout
        ? { type: 'done', terminationReason: timeout ? 'timeout' : 'interrupted' }
        : { type: 'error', terminationReason: 'failed', message: `${options.agent.displayName} 进程已退出，但未返回完整结果；未自动重新执行。` });
      await persistStatus(job, status);
      runs.delete(job.id); tasks.delete(job.id); stopped.delete(job.id);
      if (native) nativeLeases.delete(native);
    }
  };
  const submit = async (input: WorkerSubmission): Promise<WorkerJob> => exclusive(async () => {
    if (closing) throw new HttpError(503, '执行服务正在停止');
    validateSubmission(input);
    if (input.options.delivery && (input.options.delivery.sourceId !== options.sourceId || input.options.delivery.botAppId !== options.botAppId)) throw new HttpError(409, '执行服务的数据来源或飞书应用不匹配');
    const id = jobIdFor(input.requestKey), fingerprint = submissionFingerprint(input);
    const previous = store.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, '同一请求 ID 的内容已变化，未重复执行');
      return previous;
    }
    const delivery = input.options.delivery;
    if (delivery?.messageIds?.length && store.list().some(job => job.options.delivery?.scope === delivery.scope &&
      job.options.delivery?.messageIds?.some(id => delivery.messageIds!.includes(id)))) throw new HttpError(409, '消息已由原任务接收，未重复执行；请重新发送本次新增内容');
    const native = input.options.sessionId ?? input.options.initialSessionId;
    if (tasks.size >= (options.maxConcurrent ?? 2)) throw new HttpError(429, '执行服务已达到并发上限');
    if ((native && nativeLeases.has(native)) || store.list().some(job => isJobActive(job) && input.options.delivery && job.options.delivery?.scope === input.options.delivery.scope)) throw new HttpError(409, '该会话已有任务运行', true);
    const job: WorkerJob = { ...input, options: { ...input.options, runId: id }, version: 1, id, fingerprint, status: 'accepted', createdAt: Date.now(), updatedAt: Date.now() };
    await store.put(job);
    if (native) nativeLeases.add(native);
    const task = Promise.resolve().then(() => execute(job)); tasks.set(id, task);
    void task.catch(() => {}); // Persist errors in execute; failed disk writes remain visible on restart.
    return job;
  });
  const token = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => reply(res, error instanceof HttpError ? error.status : 500,
      { error: error instanceof Error ? error.message : String(error), retryable: error instanceof HttpError && error.retryable }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'Unauthorized');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { version: 1, toolId: options.agent.id, sourceId: options.sourceId, botAppId: options.botAppId, nativeReasoningEfforts: true, ...(options.agent.id === 'zcode' ? { zcodeRegistryResume: true } : {}) });
    if (req.method === 'GET' && url.pathname === '/jobs') return reply(res, 200, store.list());
    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_000_000) throw new HttpError(413, 'Request too large'); body += chunk; }
      return reply(res, 200, await submit(JSON.parse(body)));
    }
    const match = /^\/jobs\/([a-f0-9]{64})(\/stop)?$/.exec(url.pathname);
    if (!match || !store.get(match[1]!)) throw new HttpError(404, 'Task not found');
    const id = match[1]!;
    if (req.method === 'POST' && match[2]) {
      stopped.add(id); await runs.get(id)?.stop();
      if (!tasks.has(id)) stopped.delete(id);
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !match[2]) {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid event cursor');
      return reply(res, 200, store.snapshot(id, after));
    }
    throw new HttpError(405, 'Method not allowed');
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid worker address');
  const endpointFile = join(options.stateDir, 'endpoint.json');
  await writeFileAtomic(endpointFile, `${JSON.stringify({ version: 1, url: `http://127.0.0.1:${address.port}`, token, pid: process.pid })}\n`, { mode: 0o600 });
  await chmod(endpointFile, 0o600);
  return {
    store,
    async close(): Promise<void> {
      closing = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeIdleConnections();
      for (const id of tasks.keys()) stopped.add(id);
      await Promise.allSettled([...runs.values()].map(run => run.stop()));
      await Promise.allSettled([...tasks.values()]); await closed;
      const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
      if (endpoint.token === token) await unlink(endpointFile);
      await release();
    },
  };
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
function validateSubmission(input: WorkerSubmission): void {
  if (!input || typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 1000 ||
    typeof input.options?.prompt !== 'string' || !input.options.prompt.trim() || typeof input.options.cwd !== 'string' || !input.options.cwd) throw new HttpError(400, 'Invalid task');
}
