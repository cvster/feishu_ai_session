import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AgentAdapter, AgentRun, AgentEvent } from '../agent/types';
import { log } from '../core/logger';
import { JobStore, jobIdFor, submissionFingerprint } from './store';
import { isJobActive, type WorkerJob, type WorkerSubmission, type WorkerSessionService, type WorkerManifest } from './protocol';
import { handleWorkerToolRequest, workerCapabilities, readWorkerBody, WorkerApiError, type WorkerToolApi } from './tool-api';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveRunReasoning } from './reasoning';
import { PersistentScheduler } from './scheduler';

const CLOSE_GRACE_MS = 5000;
/** ~36 s: longer than the 30 s stale window of a SIGKILLed holder. */
const LOCK_RETRIES = 12;

export interface WorkerServerOptions {
  stateDir: string;
  agent: AgentAdapter;
  sourceId: string;
  botAppId: string;
  maxConcurrent?: number;
  maxQueued?: number;
  sessions?: WorkerSessionService;
  manifest?: WorkerManifest;
  /** Diagnostic/test overrides; production probes stale observers conservatively. */
  livenessIntervalMs?: number;
  livenessGraceMs?: number;
  recoveryIntervalMs?: number;
}
class HttpError extends WorkerApiError {
  constructor(status: number, message: string, retryable = status === 429 || status === 503) {
    super(status, message, status === 400 || status === 413 || status === 405 ? 'invalid-request' : status === 401 ? 'unauthorized' : status === 404 ? 'not-found' : status === 429 ? 'busy' : status === 409 ? 'conflict' : status === 503 ? 'unavailable' : 'internal-error', retryable);
  }
}

export async function startWorkerServer(options: WorkerServerOptions) {
  for(const limit of [options.maxConcurrent??4,options.maxQueued??1000])if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Worker queue limits must be positive integers');
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(options.stateDir, 'worker.lock');
  await writeFile(lockPath, '', { flag: 'a', mode: 0o600 });
  // A killed predecessor leaves the lock until it goes stale; wait it out
  // instead of failing every systemd restart attempt in the meantime.
  const release = await lockfile.lock(lockPath, { realpath: false, stale: 30_000, update: 5_000,
    retries: { retries: LOCK_RETRIES, factor: 1, minTimeout: 3000, maxTimeout: 3000 } });
  const store = new JobStore(join(options.stateDir, 'jobs'));
  try { await store.load(); } catch (error) { await release(); throw error; }
  for (const job of store.list()) if (isJobActive(job)) {
    if(job.status==='accepted'&&job.enqueue&&job.queue?.version===1&&!job.queue.dispatchedAt)continue;
    const terminal = store.snapshot(job.id)?.events.map(row => row.event).reverse().find(event => event.type === 'done' || event.type === 'error');
    if (terminal) {
      await store.put({ ...job, status: terminal.type === 'error' && terminal.submissionStatus === 'unknown' ? 'unknown' : terminal.type === 'done' && terminal.terminationReason === 'normal' ? 'completed' : terminal.terminationReason === 'interrupted' ? 'interrupted' : 'failed', updatedAt: Date.now() });
      continue;
    }
    // A crash may occur on either side of spawn. Never replay an uncertain request.
    await store.append(job.id, { type: 'error', submissionStatus:'unknown', terminationReason: 'failed', message: '执行服务曾退出，任务状态无法确认；未自动重新执行。请检查已产生的操作。' });
    const init=store.snapshot(job.id)?.events.map(r=>r.event).reverse().find(e=>e.type==='system'&&(e.threadId||e.sessionId));
    const native=job.queue?.nativeId??(init?.type==='system'?init.threadId??init.sessionId:undefined)??job.options.threadId??job.options.sessionId??job.options.initialSessionId;
    await store.put({ ...job, status: 'unknown', updatedAt: Date.now(), error: 'worker-restarted',
      ...(native?{queue:{version:1 as const,sequence:job.queue?.sequence??job.createdAt,dispatchedAt:job.queue?.dispatchedAt??job.createdAt,recoveryPending:true,nativeId:native}}:{}) });
  }
  const runs = new Map<string, AgentRun>();
  const tasks = new Map<string, Promise<void>>();
  const stopped = new Set<string>();
  const detaching = new Set<string>();
  const nativeLeases = new Set<string>();
  let closing = false;
  let draining = false;
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = serial.then(fn); serial = task.catch(() => {}); return task;
  };
  const toolApi: WorkerToolApi = {
    agent: options.agent, sessions: options.sessions ? { ...options.sessions,
      ...(options.sessions.conversation ? { conversation: async (nativeId: string) => {
        const snapshot = await options.sessions!.conversation!(nativeId);
        return { ...snapshot, turns: snapshot.turns.map(turn => {
          const job = store.list().find(job => {
            const native = job.options.threadId ?? job.options.sessionId ?? job.options.initialSessionId;
            return (native === nativeId && turn.bridgeJobId === job.id) || store.snapshot(job.id)?.events.some(row =>
              row.event.type === 'system' && (row.event.threadId ?? row.event.sessionId) === nativeId && row.event.turnId === turn.id);
          });
          // Never trust an unverified native-to-job hint from a provider.
          const { bridgeJobId: _hint, ...value } = turn;
          return { ...value, bridge: turn.bridge || !!job, ...(job ? { bridgeJobId: job.id } : {}) };
        }) };
      } } : {}),
      ...(options.sessions.questions ? { questions: async (nativeId: string) => {
        const questions = await options.sessions!.questions!(nativeId);
        return questions.map(question => {
          const job = store.list().find(job => store.snapshot(job.id)?.events.some(row => row.event.type === 'system' &&
            (row.event.threadId ?? row.event.sessionId) === nativeId && row.event.turnId === question.request.turnId));
          return job ? { ...question, origin: 'worker' as const, delivery: job.options.delivery } : question;
        });
      } } : {}),
    } : undefined, exclusive,
    connectionExclusive: 'desktopRemoteEnabled' in options.agent && options.agent.desktopRemoteEnabled === true,
    assertIdle(nativeId) {
      if (closing) throw new HttpError(503, '执行服务正在停止');
      const busy = nativeId === undefined ? tasks.size > 0 : store.list().some(job => {
        if (!isJobActive(job)) return false;
        if ([job.options.threadId, job.options.sessionId, job.options.initialSessionId].includes(nativeId)) return true;
        return store.snapshot(job.id)?.events.some(row => row.event.type === 'system' &&
          (row.event.sessionId === nativeId || row.event.threadId === nativeId));
      });
      if (busy) throw new HttpError(429, `${options.agent.displayName} 正在执行，请完成或停止后重试；未替换其连接`);
    },
  };
  const persistStatus = async (job: WorkerJob, status: WorkerJob['status'], error?: string) =>
    store.put({ ...job, status, updatedAt: Date.now(), ...(error ? { error } : {}) });
  const execute = async (job: WorkerJob): Promise<void> => {
    const native = job.options.threadId ?? job.options.sessionId ?? job.options.initialSessionId;
    let observedNative = native;
    let run: AgentRun | undefined;
    let terminal = false;
    let status: WorkerJob['status'] = 'failed';
    let lastActivityAt = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let timeout = false;
    let waitingForInput = false;
    let activityVersion = 0;
    let recoveryEvent: AgentEvent | undefined;
    let livenessTimer: ReturnType<typeof setInterval> | undefined;
    let checkingLiveness = false;
    let orphanEvidence = '';
    let orphanConfirmations = 0;
    try {
      if (stopped.has(job.id)) { status = 'interrupted'; return; }
      let runOptions=job.options;
      if(!runOptions.sessionId&&!runOptions.threadId&&runOptions.delivery?.scope){
        const previous=store.list().filter(j=>j.id!==job.id&&j.createdAt<=job.createdAt&&j.queue?.dispatchedAt&&j.options.delivery?.scope===runOptions.delivery!.scope&&j.options.delivery.sourceId===runOptions.delivery!.sourceId&&j.options.delivery.botAppId===runOptions.delivery!.botAppId&&(!runOptions.initialSessionId||j.options.initialSessionId===runOptions.initialSessionId)).sort((a,b)=>(b.queue?.sequence??b.createdAt)-(a.queue?.sequence??a.createdAt));
        for(const prior of previous){
          const init=store.snapshot(prior.id)?.events.map(r=>r.event).reverse().find(e=>e.type==='system'&&(e.sessionId||e.threadId));
          if(init?.type==='system'){runOptions={...runOptions,initialSessionId:undefined,...(init.threadId?{threadId:init.threadId}:{sessionId:init.sessionId})};break;}
        }
      }
      observedNative=runOptions.threadId??runOptions.sessionId??runOptions.initialSessionId;
      if(observedNative)nativeLeases.add(observedNative);
      await options.agent.prepareRun?.(runOptions);
      const reasoning = await resolveRunReasoning(options.agent, options.sessions, runOptions);
      if (stopped.has(job.id) || closing) { status = 'interrupted'; return; }
      await persistStatus(job, 'running');
      // stop/close may win while the running transition is being fsynced.
      if(stopped.has(job.id)||closing){status='interrupted';return;}
      options.agent.setBotIdentity?.(job.botIdentity ?? { openId: '' });
      run = options.agent.run({ ...runOptions, runId: job.id, reasoningEffort: reasoning.nativeEffort }); runs.set(job.id, run);
      await store.append(job.id, { type: 'system', requestedReasoningEffort: reasoning.requested,
        reasoningEffort: reasoning.nativeEffort ?? 'unavailable', ...(reasoning.model ? { model: reasoning.model } : {}) });
      if (run.checkLiveness && run.detach) {
        const check = async () => {
          if (checkingLiveness || runs.get(job.id) !== run || terminal || recoveryEvent || closing || stopped.has(job.id) || timeout) return;
          if (waitingForInput || options.sessions?.waitingForInput?.(observedNative ?? '') || Date.now() - lastActivityAt < (options.livenessGraceMs ?? 120_000)) {
            orphanEvidence = ''; orphanConfirmations = 0; return;
          }
          checkingLiveness = true;
          const version = activityVersion;
          try {
            const proof = await run!.checkLiveness!();
            if (runs.get(job.id) !== run || terminal || closing || stopped.has(job.id) || timeout || waitingForInput || options.sessions?.waitingForInput?.(observedNative ?? '') || version !== activityVersion) {
              orphanEvidence = ''; orphanConfirmations = 0; return;
            }
            if (proof.state !== 'orphaned' || !proof.evidence) { orphanEvidence = ''; orphanConfirmations = 0; return; }
            orphanConfirmations = orphanEvidence === proof.evidence ? orphanConfirmations + 1 : 1;
            orphanEvidence = proof.evidence;
            if (orphanConfirmations < 3) return;
            // End only our observer. Never stop the native task or resend input.
            recoveryEvent = { type: 'error', terminationReason: 'failed', submissionStatus: 'unknown', message: proof.message };
            await run!.detach!();
            log.warn('worker', 'orphaned-run-recovered', { jobId: job.id, toolId: options.agent.id });
          } catch (error) {
            if (!terminal) recoveryEvent = undefined;
            orphanEvidence = ''; orphanConfirmations = 0;
            log.warn('worker', 'liveness-check-unavailable', { jobId: job.id, message: error instanceof Error ? error.message : String(error) });
          } finally { checkingLiveness = false; }
        };
        livenessTimer = setInterval(() => { void check(); }, options.livenessIntervalMs ?? 15_000);
        livenessTimer.unref();
      }
      if (job.options.idleTimeoutMs) {
        timer = setInterval(() => {
          const promptWaiting = !!observedNative && options.sessions?.waitingForInput?.(observedNative);
          if (waitingForInput || promptWaiting) { lastActivityAt = Date.now(); return; }
          if (Date.now() - lastActivityAt >= job.options.idleTimeoutMs! && !timeout) {
            timeout = true; void run!.stop().catch(() => {});
          }
        }, Math.min(1000, job.options.idleTimeoutMs));
      }
      for await (const event of run.events) {
        activityVersion++; orphanEvidence = ''; orphanConfirmations = 0;
        lastActivityAt = Date.now();
        if (event.type === 'system') {
          observedNative = event.threadId ?? event.sessionId ?? observedNative;
          if (observedNative) nativeLeases.add(observedNative);
        }
        if (event.type === 'user_input') {
          waitingForInput = event.prompt.request.isBlocking;
          options.sessions?.receiveInput?.({ ...event.prompt, respond: async answers => {
            const accepted = await event.prompt.respond(answers);
            if (accepted) { waitingForInput = false; lastActivityAt = Date.now(); }
            return accepted;
          } });
        }
        if (event.type === 'user_input_resolved') { waitingForInput = false; lastActivityAt = Date.now(); }
        await store.append(job.id, event.type === 'done' && timeout ? { ...event, terminationReason: 'timeout' } :
          event.type === 'system' && !reasoning.nativeEffort && (!event.reasoningEffort || event.reasoningEffort === 'default')
            ? { ...event, reasoningEffort: 'unavailable' } : event);
        if (event.type === 'done' || event.type === 'error') {
          terminal = true;
          status = event.type === 'error' && event.submissionStatus === 'unknown' ? 'unknown' : event.type === 'done' && event.terminationReason === 'normal' ? 'completed' :
            event.terminationReason === 'interrupted' || stopped.has(job.id) ? 'interrupted' : 'failed';
          if (timer) { clearInterval(timer); timer = undefined; }
        }
      }
      if (!terminal && recoveryEvent) {
        await store.append(job.id, recoveryEvent); terminal = true; status = 'unknown';
      }
      if(!terminal&&detaching.has(job.id)){
        await store.append(job.id,{type:'error',submissionStatus:'unknown',terminationReason:'failed',message:'执行服务已断开观察，原生任务未停止；等待核实结果。'});
        terminal=true;status='unknown';
      }
      if (!await run.waitForExit(5000)) await run.stop();
      if (!terminal && (stopped.has(job.id) || timeout)) status = 'interrupted';
    } catch (error) {
      terminal = true;
      status = stopped.has(job.id) || timeout ? 'interrupted' : 'failed';
      await store.append(job.id, { type: 'error', terminationReason: timeout ? 'timeout' : stopped.has(job.id) ? 'interrupted' : 'failed', message: error instanceof Error ? error.message : String(error) });
      if (run) await run.stop().catch(() => {});
    } finally {
      if (livenessTimer) clearInterval(livenessTimer);
      if (timer) clearInterval(timer);
      if (!terminal) await store.append(job.id, status === 'interrupted' || stopped.has(job.id) || timeout
        ? { type: 'done', terminationReason: timeout ? 'timeout' : 'interrupted' }
        : { type: 'error', terminationReason: 'failed', message: `${options.agent.displayName} 进程已退出，但未返回完整结果；未自动重新执行。` });
      if(status==='unknown')await store.put({...job,status,updatedAt:Date.now(),queue:{version:1,sequence:job.queue?.sequence??job.createdAt,dispatchedAt:job.queue?.dispatchedAt??job.createdAt,recoveryPending:true,...(observedNative?{nativeId:observedNative}:{})}});
      else await persistStatus(job, status);
      runs.delete(job.id); stopped.delete(job.id);detaching.delete(job.id);
      if (native) nativeLeases.delete(native);
      if (observedNative) nativeLeases.delete(observedNative);
    }
  };
  const scheduler=new PersistentScheduler({store,active:tasks,limit:options.maxConcurrent??2,exclusive,execute,
    blocked:job=>{const native=job.options.threadId??job.options.sessionId??job.options.initialSessionId;return !!native&&nativeLeases.has(native);},
    onError:error=>log.warn('worker','scheduler-failed',{error:String(error)})});
  let sequence=Math.max(0,...store.list().map(j=>j.queue?.sequence??0));
  const submit = async (input: WorkerSubmission): Promise<WorkerJob> => exclusive(async () => {
    if (closing || draining) throw new HttpError(503, '执行服务正在停止接收新任务');
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
    const native = input.options.threadId ?? input.options.sessionId ?? input.options.initialSessionId;
    if(!input.enqueue){
      if (tasks.size >= (options.maxConcurrent ?? 2)) throw new HttpError(429, '执行服务已达到并发上限');
      if ((native && nativeLeases.has(native)) || store.list().some(job => isJobActive(job) &&
        ((native&&[job.options.threadId,job.options.sessionId,job.options.initialSessionId].includes(native))||
          (input.options.delivery&&job.options.delivery?.scope===input.options.delivery.scope)))) throw new HttpError(409, '该会话已有任务运行', true);
    }
    if(store.list().filter(j=>j.status==='accepted'&&!j.queue?.dispatchedAt).length>=(options.maxQueued??1000))throw new HttpError(429,'持久化等待队列已满');
    const job: WorkerJob = { ...input, options: { ...input.options, runId: id }, version: 1, id, fingerprint, status: 'accepted', createdAt: Date.now(), updatedAt: Date.now(),queue:{version:1,sequence:++sequence} };
    await store.put(job);
    scheduler.kick();
    return job;
  });
  const token = randomBytes(32).toString('hex');
  let recovering=false;
  const recover=async()=>{
    if(recovering||closing||!options.sessions?.conversation)return;
    recovering=true;
    try{for(const job of store.list().filter(j=>j.queue?.recoveryPending)){
      const native=job.queue?.nativeId??job.options.threadId??job.options.sessionId??job.options.initialSessionId;
      const turnIds=new Set(store.snapshot(job.id)?.events.flatMap(r=>r.event.type==='system'&&r.event.turnId?[r.event.turnId]:[])??[]);
      if(!native||!turnIds.size)continue; // No exact proof: quarantine, never guess or replay.
      try{
        const snapshot=await options.sessions.conversation(native);
        if(snapshot.id!==native)continue;
        const turn=snapshot.turns.find(t=>turnIds.has(t.id));
        if(!turn||turn.state.terminal==='running')continue;
        await exclusive(async()=>{
          const current=store.get(job.id);if(!current?.queue?.recoveryPending)return;
          const status=turn.state.terminal==='done'?'completed':turn.state.terminal==='interrupted'?'interrupted':'failed';
          await store.append(job.id,status==='failed'?{type:'error',terminationReason:'failed',message:'原生任务已结束，状态已核实'}:{type:'done',terminationReason:status==='completed'?'normal':'interrupted'});
          await store.put({...current,status,updatedAt:Date.now(),queue:{...current.queue,recoveryPending:false},error:undefined});
        });scheduler.kick();
      }catch{/* Keep the native lease quarantined until authoritative evidence returns. */}
    }}finally{recovering=false;}
  };
  const recoveryTimer=setInterval(()=>{void recover();},options.recoveryIntervalMs??10_000);recoveryTimer.unref();
  const server = createServer((req, res) => {
    // Keep-alive pollers would otherwise hold server.close() open indefinitely.
    if (closing) res.shouldKeepAlive = false;
    void handle(req, res).catch(error => reply(res, error instanceof WorkerApiError ? error.status : 500,
      { error: error instanceof Error ? error.message : String(error), code: error instanceof WorkerApiError ? error.code : 'internal-error', retryable: error instanceof WorkerApiError && error.retryable }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'Unauthorized');
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Compute transport exclusivity dynamically for capability changes in adapters.
    toolApi.connectionExclusive = 'desktopRemoteEnabled' in options.agent && options.agent.desktopRemoteEnabled === true;
    if (await handleWorkerToolRequest(req, res, url, toolApi)) return;
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { version: 1, toolId: options.agent.id, sourceId: options.sourceId, botAppId: options.botAppId, manifest: options.manifest ?? { label: options.agent.displayName, nativeField: 'sessionId', sessionKind: 'native-session', historyFormat: 'json', nativeHistory: false }, capabilities: workerCapabilities(toolApi), nativeReasoningEfforts: true, ...(options.agent.id === 'zcode' ? { zcodeRegistryResume: true, zcodeNativeStop: 'desktopRemoteEnabled' in options.agent && options.agent.desktopRemoteEnabled === true && typeof options.agent.stopNativeTurn === 'function', zcodeSessionNames: 'desktopRemoteEnabled' in options.agent && options.agent.desktopRemoteEnabled === true && typeof options.agent.renameSession === 'function', zcodeDesktopRemote: 'desktopRemoteEnabled' in options.agent && options.agent.desktopRemoteEnabled === true, zcodeDesktopRemoteConfigId: 'desktopRemoteConfigId' in options.agent ? options.agent.desktopRemoteConfigId : undefined } : {}), ...(options.agent.id === 'kilo' ? { kiloEditorSync: true, kiloNativeInputOrigin: true } : {}) });
    if (req.method === 'GET' && url.pathname === '/jobs') return reply(res, 200, store.list());
    if (req.method === 'POST' && url.pathname === '/jobs') {
      return reply(res, 200, await submit(await readWorkerBody(req, 2_000_000) as unknown as WorkerSubmission));
    }
    if(req.method==='POST'&&url.pathname==='/drain'){
      await exclusive(async()=>{draining=true;scheduler.pause();});
      return reply(res,200,{draining:true,active:tasks.size,queued:store.list().filter(j=>j.status==='accepted'&&!j.queue?.dispatchedAt).length});
    }
    const match = /^\/jobs\/([a-f0-9]{64})(\/(?:stop|recover))?$/.exec(url.pathname);
    if (!match || !store.get(match[1]!)) throw new HttpError(404, 'Task not found');
    const id = match[1]!;
    if(req.method==='POST'&&match[2]==='/recover'){
      const body=await readWorkerBody(req,1024);
      if(body.confirm!==id)throw new HttpError(400,'必须显式确认原任务已停止；不会重新执行原消息');
      await exclusive(async()=>{
        const job=store.get(id)!;if(!job.queue?.recoveryPending)throw new HttpError(409,'任务不处于待核实状态');
        const native=job.queue.nativeId??job.options.threadId??job.options.sessionId??job.options.initialSessionId;
        if(!native||!options.sessions?.conversation)throw new HttpError(409,'无法核实原生任务，请先恢复原生状态查询');
        const snapshot=await options.sessions.conversation(native);
        if(snapshot.id!==native||snapshot.turns.some(t=>t.state.terminal==='running'))throw new HttpError(409,'原生会话仍在运行或身份未确认，未释放队列');
        await store.put({...job,updatedAt:Date.now(),queue:{...job.queue,recoveryPending:false},error:'operator-confirmed-no-replay'});
      });scheduler.kick();return reply(res,200,{ok:true});
    }
    if (req.method === 'POST' && match[2]==='/stop') {
      const body=req.headers['content-length']===undefined&&!req.headers['transfer-encoding']?{}:await readWorkerBody(req,1024);
      let active:AgentRun|undefined;
      await exclusive(async()=>{
        const job=store.get(id)!;
        if(job.status==='accepted'&&!job.queue?.dispatchedAt){
          await store.append(id,{type:'done',terminationReason:'interrupted'});await persistStatus(job,'interrupted');return;
        }
        if(body.queuedOnly===true)throw new HttpError(409,'任务已开始执行，未停止当前任务');
        if(job.queue?.recoveryPending)throw new HttpError(409,'正在核实重启前的任务，不能安全停止未知进程');
        if(tasks.has(id)){stopped.add(id);active=runs.get(id);}
      });
      await active?.stop();scheduler.kick();
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
  scheduler.kick();
  void recover();
  return {
    store,
    async close(): Promise<void> {
      closing = true;
      clearInterval(recoveryTimer);
      scheduler.pause();await scheduler.idle();
      const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeIdleConnections();
      for (const id of tasks.keys())if(runs.get(id)?.detach)detaching.add(id);else stopped.add(id);
      await Promise.allSettled([...runs.entries()].map(([id,run])=>detaching.has(id)?run.detach!():run.stop()));
      await Promise.allSettled([...tasks.values()]);
      // In-flight requests get a short grace period; then drop what is left.
      const grace = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS); grace.unref();
      await closed; clearTimeout(grace);
      const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
      if (endpoint.token === token) await unlink(endpointFile);
      await options.sessions?.close?.();
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
