import { isZcodeNativeInput } from './conversation';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import * as lockfile from 'proper-lockfile';
import { decodeRpc, encodeRpc, RemoteFrames } from './remote-wire';
import { requestZcodeTerminalToken, zcodeDesktopCredentialFile } from './remote-auth';
import { normalizeNativeModels, type ModelOption } from '../models';

export interface ZcodePairing { deviceSid: string; passHash?: string; deviceMid?: string; appVersion?: string }
export function parseZcodePairing(link: string): ZcodePairing {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new Error('ZCode 远控链接格式无效'); }
  if (url.protocol !== 'https:' || url.hostname !== 'zcode.z.ai' || url.port || url.username || url.password || !/^\/remote(?:\/v[34])?\/?$/.test(url.pathname)) throw new Error('请使用 ZCode 官方桌面复制的远控链接');
  const deviceSid = url.searchParams.get('sid'), passHash = url.searchParams.get('hash');
  if (!deviceSid || deviceSid.length > 128 || (passHash !== null && (!passHash || passHash.length > 4096 || !url.searchParams.get('t') || !Number.isFinite(Number(url.searchParams.get('t')))))) throw new Error('ZCode 远控链接缺少配对信息');
  return { deviceSid, ...(passHash ? { passHash } : {}), deviceMid: url.searchParams.get('mid') || undefined, appVersion: url.searchParams.get('app_version') || undefined };
}
export async function readZcodePairing(path: string): Promise<ZcodePairing> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('ZCode 配对文件必须属于当前用户且权限为 600');
    return parseZcodePairing(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export const zcodeAuthProof = (pair: ZcodePairing, nonce: string) => {
  if (!pair.passHash) throw new Error('ZCode V2 does not use a challenge proof');
  return createHmac('sha256', pair.passHash).update(`${nonce}|terminal|${pair.deviceSid}`).digest('base64url');
};

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/** One authenticated terminal / workspace attachment. No reconnect or mutation replay.
 * Closing releases this attachment only; it never kills the desktop or its Agent.
 */
export class ZcodeRemoteClient {
  private socket?: WebSocket;
  private frames = new RemoteFrames(`feishu-${randomUUID()}`);
  private rpcNext = 0;
  private rpc = new Map<number, Pending>();
  private app = new Map<string, Pending>();
  private events = new Map<number, (value: any) => void>();
  private listeners = new Set<(method: string, params: any) => void>();
  private ready: Promise<void>;
  private initialized = false;
  private initWait?: Pending;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastAck = Date.now();
  private pairedWait?: Pending;
  private target?: { workspacePath: string };
  private clientId = `feishu-${randomUUID()}`;
  private release?: () => Promise<void>;
  private closed = false;
  private finishExit!: () => void;
  private subscribed = false;
  private inputId?: string;
  private turnId?: string;
  private executionId?: string;
  private v2 = false;
  private phase = 'read-pairing';
  readonly exited = new Promise<void>(resolve => { this.finishExit = resolve; });
  onInteraction?: (method: string, params: any) => void;
  constructor(pairingFile: string, cwd: string, /** Loopback fixture only; production always uses the official relay. */ testRelay?: string, credentialFile = zcodeDesktopCredentialFile()) {
    this.ready = this.connect(pairingFile, cwd, testRelay, credentialFile).catch(async () => {
      await this.close(); throw new Error(`ZCode 桌面远控连接失败（阶段：${this.phase}），请检查配对链接、桌面和工作区；本次未改用独立 Agent，也未自动重发。`);
    });
    // A constructor can fail before the first request is awaited.
    void this.ready.catch(() => {});
  }
  private deferred<T>(map: Map<T, Pending>, id: T, timeout = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { map.delete(id); reject(new Error('ZCode 远控回执超时，未自动重发')); }, timeout);
      map.set(id, { resolve, reject, timer });
    });
  }
  private settle(map: Map<any, Pending>, id: any, value: any, error?: Error) {
    const pending = map.get(id); if (!pending) return;
    clearTimeout(pending.timer); map.delete(id);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private send(value: unknown) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw new Error('ZCode 远控已断开，任务状态可能未知；未自动重发');
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('ZCode relay frame too large');
    this.socket.send(data);
  }
  private timestamp() { return this.v2 ? Math.floor(Date.now() / 1000) : Date.now(); }
  private payload(value: unknown) { this.send({ type: 'data', payload: value, client_ts: this.timestamp() }); }
  private async appRequest(type: string, params: object = {}) {
    const requestId = randomUUID(), response = this.deferred(this.app, requestId);
    try { this.payload({ zcode_type: type, requestId, ...params }); }
    catch (error) { this.settle(this.app, requestId, undefined, error as Error); }
    return response;
  }
  private async connect(path: string, cwd: string, testRelay?: string, credentialFile?: string) {
    const pair = await readZcodePairing(path);
    this.release = await lockfile.lock(path, { realpath: true, stale: 30_000, update: 5_000, onCompromised: () => { void this.close(); } });
    if (this.closed) { await this.release(); this.release = undefined; throw new Error('ZCode remote closed'); }
    this.v2 = !pair.passHash;
    const url = new URL(testRelay ?? (this.v2 ? 'wss://zcode.z.ai/api/v1/remote/ws2' : 'wss://zcode.z.ai/ws'));
    if (testRelay && !/^ws:\/\/127\.0\.0\.1:\d+\/$/.test(url.href)) throw new Error('Invalid test relay');
    if (this.v2) {
      this.phase = 'authorize';
      const testOrigin = testRelay ? `http://${url.host}` : undefined;
      url.searchParams.set('token', await requestZcodeTerminalToken(pair, credentialFile!, testOrigin));
      if (this.closed) throw new Error('ZCode remote closed');
    }
    if (pair.deviceMid) url.searchParams.set('mid', pair.deviceMid);
    this.phase = 'websocket';
    const paired = new Promise<void>((resolve, reject) => {
      this.pairedWait = { resolve, reject, timer: setTimeout(() => reject(new Error('ZCode pairing timeout')), 30_000) };
    });
    this.socket = new WebSocket(url, { maxPayload: 1024 * 1024 });
    this.socket.on('open', () => {
      try { this.send({ type: 'auth_init', ...(!this.v2 ? { role: 'terminal' } : {}), device_sid: pair.deviceSid,
        meta: { platform: 'web', version: pair.appVersion ?? 'feishu-bridge', name: 'feishu-bridge' }, client_ts: this.timestamp() }); }
      catch { void this.close(); }
    });
    this.socket.on('error', () => { void this.close(); });
    this.socket.on('close', () => { void this.close(); });
    this.socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'auth_challenge') {
          if (typeof message.nonce !== 'string' || message.nonce.length > 4096) throw new Error('Invalid auth challenge');
          this.send({ type: 'auth_response', device_sid: pair.deviceSid, proof: zcodeAuthProof(pair, message.nonce), client_ts: Date.now() });
        } else if (message.type === 'auth_ack' || message.type === 'pair_status_ack') {
          if (message.device_sid && message.device_sid !== pair.deviceSid) throw new Error('Mismatched pairing');
          this.lastAck = Date.now();
          if (!this.heartbeat) this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastAck > 30_000) { void this.close(); return; }
            try { this.send({ type: 'pair_status_query', ...(!this.v2 ? { device_sid: pair.deviceSid } : {}), client_ts: this.timestamp() }); } catch { void this.close(); }
          }, 10_000);
          if (message.pair_status === 'matched' && this.pairedWait) {
            clearTimeout(this.pairedWait.timer); this.pairedWait.resolve(undefined); this.pairedWait = undefined;
          } else if (message.pair_status === 'waiting' && !this.pairedWait) throw new Error('ZCode desktop disconnected');
        } else if (message.type === 'data') this.receivePayload(message.payload);
        else if (message.type === 'error') throw new Error('ZCode relay rejected connection');
      } catch { void this.close(); }
    });
    await paired;
    this.phase = 'bootstrap';
    const bootstrap = await this.appRequest('bootstrap-request');
    const workspaces = bootstrap.result?.workspaces;
    this.phase = 'select-workspace';
    const candidates = Array.isArray(workspaces) ? workspaces.filter((w: any) => !w.remoteSessionId && !w.workspaceIdentity && w.kind !== 'remote' && typeof w.workspacePath === 'string' && resolve(w.workspacePath) === resolve(cwd)) : [];
    if (candidates.length !== 1) throw new Error('ZCode 桌面需打开唯一匹配的本地工作区');
    this.target = { workspacePath: candidates[0].workspacePath };
    this.phase = 'open-workspace';
    const opened = await this.appRequest('workspace-bridge-open', { bridgeSessionId: this.frames.bridgeSessionId, workspaceKey: candidates[0].workspaceKey ?? candidates[0].workspacePath });
    if (opened.bridge?.bridgeSessionId !== this.frames.bridgeSessionId || opened.bridge?.kind !== 'local' || opened.bridge?.workspacePath !== this.target.workspacePath) throw new Error('Mismatched ZCode workspace attachment');
    if (!this.initialized) await new Promise<void>((resolve, reject) => {
      this.initWait = { resolve, reject, timer: setTimeout(() => reject(new Error('ZCode RPC initialize timeout')), 15_000) };
    });
    const hello = await this.call('helloConversationV4');
    if (hello?.kind !== 'hello' || ![1, 2, 3].includes(hello.protocolVersion) || hello.clientMode !== 'web-remote-replayable') throw new Error('Unsupported ZCode remote protocol');
    await this.call('initializeConversationV4', [{ kind: 'clientHello', protocolVersion: hello.protocolVersion,
      clientId: this.clientId, clientKind: 'mobileRemote', appVersion: 'feishu-bridge' }]);
  }
  private receivePayload(value: any) {
    if (value?.zcode_type === 'bridge-degraded') {
      // The desktop can replay faults for a previous terminal attachment.
      // Only this connection's workspace bridge can invalidate our transport.
      if (value.bridgeSessionId === this.frames.bridgeSessionId) throw new Error('ZCode remote bridge degraded');
      return;
    }
    if (value?.zcode_type === 'rpc-frame' || value?.zcode_type === 'rpc-frame-ack') {
      const { bytes, ack } = this.frames.accept(value);
      if (ack) this.payload(ack);
      if (bytes) {
        const { header, body } = decodeRpc(bytes), [type, id] = header;
        if (type === 200) {
          this.initialized = true;
          if (this.initWait) { clearTimeout(this.initWait.timer); this.initWait.resolve(undefined); this.initWait = undefined; }
        } else if (type === 201) this.settle(this.rpc, id, body);
        else if (type === 202 || type === 203) this.settle(this.rpc, id, undefined, new Error('ZCode 桌面拒绝请求，请在桌面检查模型、权限或会话状态'));
        else if (type === 204) this.events.get(id)?.(body);
      }
    } else if (value?.requestId && this.app.has(value.requestId)) {
      if (value.success === false || value.zcode_type.endsWith('-error')) this.settle(this.app, value.requestId, undefined, new Error('ZCode workspace request rejected'));
      else this.settle(this.app, value.requestId, value);
    }
  }
  private writeRpc(header: unknown[], body?: unknown) { for (const frame of this.frames.encode(encodeRpc(header, body))) this.payload(frame); }
  private async call(method: string, args: unknown[] = [], channel = 'zcode-agent'): Promise<any> {
    const id = ++this.rpcNext, response = this.deferred(this.rpc, id);
    try { this.writeRpc([100, id, channel, method], args); }
    catch (error) { this.settle(this.rpc, id, undefined, error as Error); }
    return response;
  }
  onNotification(listener: (method: string, params: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Submit the official remote UI's native V4 input command with durable origin.
   * Legacy sendPrompt omits inputOrigin and cannot exercise native mirroring.
   * This is an explicit native input seam; bridge jobs keep using session/send.
   */
  async sendNativeText(sessionId: string, text: string, model: { providerId: string; modelId: string; options?: object }): Promise<void> {
    await this.ready;
    const result = await this.call('sendConversationCommandV4', [{ ...this.target!, sessionId, envelope: {
      commandId: randomUUID(), clientId: this.clientId, sessionId, issuedAt: Date.now(), type: 'sendText',
      payload: { text, inputOrigin: 'mobile', requestedDelivery: 'startNow', modelSelection: model },
    } }]);
    if (!['accepted', 'duplicate'].includes(result?.status)) throw new Error('ZCode 桌面未确认原生输入，未自动重发');
  }
  /** Desktop archiveTask changes the native task index, not session.archivedAt. */
  async isNativeTaskArchived(sessionId: string): Promise<boolean> {
    await this.ready;
    const archived = await this.call('listArchivedTasks', [this.target!], 'zcode-task');
    if (!Array.isArray(archived)) throw new Error('ZCode 原生归档列表未返回数据');
    const match = archived.find(row => row?.taskId === sessionId);
    if (match) {
      if (match.workspacePath !== this.target!.workspacePath) throw new Error('ZCode 原生归档会话项目不匹配');
      return true;
    }
    const meta = await this.call('getTaskMeta', [{ ...this.target!, taskId: sessionId }], 'zcode-task');
    if (meta?.taskId !== sessionId || meta?.workspacePath !== this.target!.workspacePath)
      throw new Error('ZCode 原生归档状态未返回匹配的会话和项目');
    return false;
  }
  async request<T = any>(method: string, params: any): Promise<T> {
    await this.ready;
    const target = { ...this.target!, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
    let result: any;
    switch (method) {
      // Credentials and provider registries stay in the desktop. Never transmit them over relay.
      case 'workspace/updateProviderRegistry': result = {}; break;
      case 'workspace/readPresentation': result = await this.call('readWorkspacePresentation', [target]); break;
      case 'session/resume': result = await this.call('resumeSession', [target]); break;
      case 'session/read': result = await this.call('readSession', [target]); break;
      case 'session/list': {
        const rows = await this.call('listSessions', [{ ...target, limit: 100, includeArchived: true }]);
        result = Array.isArray(rows) ? { sessions: rows } : rows;
        break;
      }
      case 'session/archive': result = await this.call('archiveTask', [{ workspacePath: target.workspacePath, taskId: params.sessionId }], 'zcode-task'); break;
      case 'session/rename': {
        if (!params.title?.trim()) throw new Error('ZCode 会话名不能为空');
        const before = await this.call('readSession', [target]);
        if (before.session?.sessionId !== params.sessionId) throw new Error('ZCode 原生会话不存在，未改名');
        // Empty native sessions do not yet have a legacy task-index entry.
        // Rename through the same V4 command as the desktop conversation header.
        result = await this.call('sendConversationCommandV4', [{ ...target, envelope: {
          commandId: randomUUID(), clientId: this.clientId, sessionId: params.sessionId, issuedAt: Date.now(),
          type: 'renameSession', payload: { title: params.title },
        } }]);
        if (!['accepted', 'noop', 'duplicate'].includes(result?.status)) throw new Error('ZCode 桌面未确认改名');
        const snapshot = await this.call('readSession', [target]);
        if (snapshot.session?.sessionId !== params.sessionId || snapshot.session?.title !== params.title)
          throw new Error('ZCode 原生会话标题尚未确认，未将改名标记为成功');
        break;
      }
      case 'session/create': result = await this.call('createSession', [{ ...target, mode: params.mode, persistence: 'immediate', titleGenerationEnabled: false, ...(params.runtimeModel ? { model: params.runtimeModel.model } : {}) }]); break;
      case 'session/setMode': result = await this.call('setMode', [{ ...target, mode: params.mode }]); break;
      case 'session/setModel': result = await this.call('setModel', [{ ...target, model: params.model }]); break;
      case 'session/setThoughtLevel': result = await this.call('setThoughtLevel', [{ ...target, thoughtLevel: params.thoughtLevel }]); break;
      case 'session/subscribe': {
        if (this.subscribed) throw new Error('Duplicate remote subscription');
        this.subscribed = true;
        const id = ++this.rpcNext;
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ZCode 桌面订阅未就绪，本次未发送')), 20_000);
          this.events.set(id, event => {
            if (event.type === 'snapshot') {
              clearTimeout(timer);
              if (event.snapshot?.session?.sessionId !== params.sessionId) { reject(new Error('ZCode 桌面订阅返回了不匹配的会话')); return; }
              resolve({});
            }
            // Runtime headers are owned by the desktop's workspace auth handler.
            // They are not a user permission question and must not end observation.
            if (['permission.request', 'userInput.request'].includes(event.type) && this.inputId) this.onInteraction?.(event.type, event);
            if (event.type !== 'session.event' || event.event?.sessionId !== params.sessionId || !this.inputId) return;
            const native = event.event;
            if (native.type === 'turn.started') {
              if (native.payload?.inputId !== this.inputId) return;
              this.turnId = native.turnId;
              this.executionId = native.payload?.foregroundExecutionId;
            }
            if (!this.turnId || native.turnId !== this.turnId) return;
            for (const listener of this.listeners) listener('session/event', native);
          });
          this.writeRpc([102, id, 'zcode-agent', 'onDynamicSessionEvent'], { ...target, deliveryKind: 'web-remote-replayable', includeSnapshot: true });
          void this.exited.then(() => { clearTimeout(timer); reject(new Error('ZCode 远控订阅已断开')); });
        });
        break;
      }
      case 'session/send':
        this.inputId = params.inputId;
        result = await this.call('sendPrompt', [{ ...target, inputId: params.inputId, content: params.content, clientMode: 'web-remote-replayable',
          ...(params.runtimeModel ? { modelSelection: { ...params.runtimeModel.model,
            ...(params.runtimeModel.thoughtLevel ? { options: { reasoningLevel: params.runtimeModel.thoughtLevel } } : {}) } } : {}) }]);
        break;
      case 'session/stopNative': {
        const before = await this.call('readSession', [target]);
        if (before.session?.sessionId !== params.sessionId || before.session?.archivedAt)
          throw new Error('ZCode 原生会话身份不匹配或已归档，未停止');
        const user = [...(before.messages ?? [])].reverse().find((row: any) => row.info?.role === 'user' && isZcodeNativeInput(row.info));
        const activeTurn = before.runtime?.activeTurnId;
        if (!activeTurn) { result = { stopped: false }; break; }
        if (!user || user.info.messageId !== params.turnId)
          throw new Error('ZCode 当前输入已变化，未停止其他任务');
        const seq = before.runtime?.eventSeq;
        const afterSeq = Number.isSafeInteger(seq) ? Math.max(0, seq - 10000) : 0;
        const events = await this.call('readSessionEvents', [{ ...target, afterSeq, limit: 10000 }]);
        const started = Array.isArray(events) ? [...events].reverse().find(event => event.type === 'turn.started' &&
          event.sessionId === params.sessionId && event.turnId === activeTurn && event.payload?.messageId === params.turnId) : undefined;
        const executionId = started?.payload?.foregroundExecutionId;
        if (typeof executionId !== 'string' || !executionId) throw new Error('尚未确认桌面执行身份，未停止其他任务');
        const current = await this.call('readSession', [target]);
        if (current.session?.sessionId !== params.sessionId || current.runtime?.activeTurnId !== activeTurn)
          throw new Error('ZCode 当前轮次已变化，未停止其他任务');
        const ack = await this.call('sendConversationCommandV4', [{ ...target, envelope: {
          commandId: randomUUID(), clientId: this.clientId, sessionId: params.sessionId, issuedAt: Date.now(),
          type: 'stop', payload: { expectedForegroundExecutionId: executionId },
        } }]);
        if (!['accepted', 'noop'].includes(ack?.status)) throw new Error('ZCode 桌面未确认停止，未自动重发');
        result = { stopped: true };
        break;
      }
      case 'session/stop': {
        if (!this.executionId) throw new Error('尚未确认本次桌面执行身份，未停止其他任务');
        result = await this.call('sendConversationCommandV4', [{ ...target, envelope: {
          commandId: randomUUID(), clientId: this.clientId, sessionId: params.sessionId, issuedAt: Date.now(), type: 'stop', payload: { expectedForegroundExecutionId: this.executionId },
        } }]);
        if (!['accepted', 'noop'].includes(result?.status)) throw new Error('ZCode 桌面未确认停止');
        break;
      }
      default: throw new Error(`Unsupported ZCode remote operation: ${method}`);
    }
    return result as T;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const p of [this.pairedWait, this.initWait]) if (p) { clearTimeout(p.timer); p.reject(new Error('ZCode remote disconnected')); }
    this.pairedWait = this.initWait = undefined;
    for (const [id] of this.rpc) this.settle(this.rpc, id, undefined, new Error('ZCode 桌面连接断开，状态可能未知；未自动重发'));
    for (const [id] of this.app) this.settle(this.app, id, undefined, new Error('ZCode remote disconnected'));
    this.events.clear(); this.socket?.terminate();
    if (this.release) { const release = this.release; this.release = undefined; await release().catch(() => {}); }
    this.finishExit();
  }
}

/** Run only in the owning worker while idle, so model discovery cannot kick a live turn. */
export async function listZcodeRemoteModels(pairingFile: string, cwd: string, credentialFile?: string, testRelay?: string): Promise<ModelOption[]> {
  const client = new ZcodeRemoteClient(pairingFile, cwd, testRelay, credentialFile);
  let temporary: string | undefined;
  try {
    const listed = await client.request('session/list', {});
    const existing = listed.sessions?.find((s: any) => s.workspace?.workspacePath === cwd || s.workspacePath === cwd);
    const snapshot = existing ? await client.request('session/read', { sessionId: existing.sessionId }) : await client.request('session/create', { mode: 'plan' });
    if (!existing) temporary = snapshot.session?.sessionId;
    const rows = snapshot.settings?.model?.available;
    if (!Array.isArray(rows)) throw new Error('ZCode 桌面模型列表格式不兼容');
    const current = snapshot.settings?.model?.current;
    return normalizeNativeModels(rows.filter((row: any) => typeof row.ref?.providerId === 'string' && typeof row.ref?.modelId === 'string' && !row.disabledReason).map((row: any) => ({
      value: `${row.ref.providerId}/${row.ref.modelId}`, label: `${row.providerLabel ?? row.ref.providerId} / ${row.label ?? row.ref.modelId}`,
      isDefault: current?.providerId === row.ref.providerId && current?.modelId === row.ref.modelId,
      ...(row.reasoning?.enabled ? { reasoningEfforts: row.reasoning.levels, defaultReasoningEffort: row.reasoning.defaultLevel } : {}),
    })));
  } finally {
    try { if (temporary) await client.request('session/archive', { sessionId: temporary }); }
    finally { await client.close(); }
  }
}
