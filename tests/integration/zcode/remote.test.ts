import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ZcodeRemoteClient, parseZcodePairing, readZcodePairing, zcodeAuthProof, listZcodeRemoteModels } from '../../../src/agent/zcode/remote-client';
import { RemoteFrames, encodeRpc, decodeRpc, crc32 } from '../../../src/agent/zcode/remote-wire';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import type { AgentEvent } from '../../../src/agent/types';

const harness = vi.hoisted(() => ({ relay: '' }));
vi.mock('../../../src/agent/zcode/remote-client', async importOriginal => {
  const real = await importOriginal<typeof import('../../../src/agent/zcode/remote-client')>();
  return { ...real, ZcodeRemoteClient: class extends real.ZcodeRemoteClient {
    constructor(file: string, cwd: string, relay?: string, credentialFile?: string) { super(file, cwd, relay ?? harness.relay, credentialFile); }
  } };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { error?: boolean; workspace?: string; closeOnSend?: boolean; complete?: boolean; wait?: boolean; v2?: boolean; foreignDevice?: boolean; autoHeaders?: boolean; staleDegraded?: boolean; ownDegraded?: boolean; renameFailure?: boolean; nativeStop?: boolean; missingExecution?: boolean; wrongMessage?: boolean; changedTurn?: boolean; rejectStop?: boolean; idle?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-remote-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pair.link');
  await writeFile(file, options.v2 ? 'https://zcode.z.ai/remote/v4?sid=device-1&app_version=3.16.2' : 'https://zcode.z.ai/remote/v4?sid=device-1&hash=dGVzdF9oYXNo&t=123&app_version=3.10.2', { mode: 0o600 });
  const credentialFile = join(dir, 'credentials.json');
  await writeFile(credentialFile, JSON.stringify({ 'oauth:active_provider': 'zai', 'oauth:zai:user_info': JSON.stringify({id:'fixture-user'}), zcodejwttoken:'PRIVATE_DESKTOP_JWT' }), {mode:0o600});
  const httpCalls: any[] = [];
  const http = createServer(async (req,res) => {
    expect(req.headers.authorization).toBe('Bearer PRIVATE_DESKTOP_JWT');
    let body=''; for await(const chunk of req) body+=chunk;
    httpCalls.push({path:req.url,method:req.method,body});
    const data = req.url === '/api/v1/remote/device' ? [{device_sid:options.foreignDevice?'other-device':'device-1',device_mid:'fixture-mid',online:true}] : {token:'A'.repeat(22),expires_in:60};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,msg:'ok',data}));
  });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0,'127.0.0.1',resolve));
  cleanup.push(async () => { for (const s of server.clients) s.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve=>http.close(()=>resolve())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('invalid fixture');
  const calls: Array<{ method: string; args: any }> = [], wire: string[] = [];
  let nativeTitle = '新会话', taskArchived = false;
  let nativeReads = 0;
  let emit!: (value: any) => void, connection: WebSocket | undefined, subscribeId: number | undefined;
  server.on('connection', (socket,request) => {
    if(options.v2) expect(new URL(request.url!,'http://localhost').searchParams.get('token')).toBe('A'.repeat(22));
    connection = socket;
    let frames: RemoteFrames;
    const send = (p: any) => socket.send(JSON.stringify(p));
    const payload = (p: any) => send({ type: 'data', payload: p });
    const rpc = (header: unknown[], body?: unknown) => { for (const frame of frames.encode(encodeRpc(header, body))) payload(frame); };
    emit = event => rpc([204, subscribeId], event);
    socket.on('message', raw => {
      wire.push(raw.toString());
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth_init') {
        if(options.v2) {
          expect(message).not.toHaveProperty('role');expect(message.client_ts).toBeLessThan(253402300799);
          send({type:'auth_ack',device_sid:'device-1',pair_status:'matched'});
        } else send({ type: 'auth_challenge', nonce: 'nonce-1' });
      }
      if (message.type === 'auth_response') {
        expect(message.proof).toBe('YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU');
        send(options.error ? { type: 'error', code: 'AUTH_FAILED', message: 'secret-upstream-error' } : { type: 'auth_ack', device_sid: 'device-1', pair_status: 'matched' });
      }
      if (message.type !== 'data') return;
      const p = message.payload;
      if (p.zcode_type === 'bootstrap-request' && options.staleDegraded) payload({zcode_type:'bridge-degraded',bridgeSessionId:'previous-terminal',reason:'rpc-transport-fault'});
      if (p.zcode_type === 'bootstrap-request') payload({ zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
        result: { workspaces: [{ workspacePath: options.workspace ?? dir, workspaceKey: options.workspace ?? dir, kind: 'local' }], tasks: [] } });
      if (p.zcode_type === 'workspace-bridge-open') {
        frames = new RemoteFrames(p.bridgeSessionId);
        if(options.ownDegraded){payload({zcode_type:'bridge-degraded',bridgeSessionId:p.bridgeSessionId,reason:'rpc-transport-fault'});return;}
        rpc([200]); // Host initializes before bridge-ready; must not lose it.
        payload({ zcode_type: 'workspace-bridge-ready', requestId: p.requestId, bridge: { bridgeSessionId: p.bridgeSessionId, kind: 'local', workspacePath: dir } });
      }
      if (p.zcode_type === 'rpc-frame' || p.zcode_type === 'rpc-frame-ack') {
        const result = frames.accept(p); if (result.ack) payload(result.ack); if (!result.bytes) return;
        const { header: [kind, id, channel, method], body } = decodeRpc(result.bytes);
        expect(['zcode-agent','zcode-task']).toContain(channel);
        calls.push({ method, args: body });
        if (kind === 102) { subscribeId = id; emit({ type: 'snapshot', snapshot: { session: { sessionId: body.sessionId } } }); return; }
        let response: any = {};
        if (method === 'helloConversationV4') response = { kind: 'hello', protocolVersion: 2, clientMode: 'web-remote-replayable' };
        if (method === 'resumeSession' || method === 'createSession') response = { session: { sessionId: body[0].sessionId ?? 'sess_new' } };
        if(method==='listSessions')response=[{sessionId:'sess_original',workspace:{workspacePath:dir}}];
        if(method==='archiveTask')taskArchived=true;
        if(method==='getTaskMeta')response={taskId:body[0].taskId,workspacePath:dir};
        if(method==='listArchivedTasks')response=taskArchived?[{taskId:'sess_original',workspacePath:dir}]:[];
        if(method==='renameTask') throw new Error('Fresh native sessions have no legacy task-index entry');
        if(method==='readSession')response={session:{sessionId:body[0].sessionId,title:nativeTitle},settings:{model:{current:{providerId:'account:native',modelId:'native-model'},available:[{ref:{providerId:'account:native',modelId:'native-model'},label:'Native Model',reasoning:{enabled:true,levels:[{value:'native-level',label:'Native Level'}],defaultLevel:'native-level'}}]}}};
        if (method === 'readSession' && options.nativeStop) {
          nativeReads++;
          response = { session: { sessionId: body[0].sessionId },
            runtime: { eventSeq: 15000, activeTurnId: options.idle ? undefined : options.changedTurn && nativeReads > 1 ? 'turn-new' : 'turn-desktop' },
            messages: [{ info: { messageId: options.wrongMessage ? 'msg-new' : 'msg-desktop', role: 'user', metadata: {
              inputIntent: { inputOrigin: 'desktop', sourceCommandId: 'desktop-command' },
            } } }] };
        }
        if (method === 'readSessionEvents') response = [{ sessionId: body[0].sessionId, type: 'turn.started', turnId: 'turn-desktop',
          payload: { messageId: 'msg-desktop', ...(options.missingExecution ? {} : { foregroundExecutionId: 'exec-desktop' }) } }];
        if (method === 'sendPrompt') {
          if (options.closeOnSend) { socket.terminate(); return; }
          response = { accepted: true };
          if (options.complete || options.wait) {
            if(options.autoHeaders)emit({type:'providerRuntimeHeaders.request',request:{sessionId:body[0].sessionId}});
            emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 1, type: 'turn.started', turnId: 'turn-own', payload: { inputId: body[0].inputId, foregroundExecutionId: 'exec-own' } } });
            emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 2, type: 'model.streaming', turnId: 'turn-own', payload: { kind: 'text_delta', delta: 'REMOTE_OK' } } });
            if (options.complete) emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 3, type: 'turn.completed', turnId: 'turn-own', payload: { inputId: body[0].inputId, response: 'REMOTE_OK', resultType: 'success' } } });
          }
        }
        if (method === 'sendConversationCommandV4') { response = { status: options.rejectStop && body[0].envelope.type === 'stop' ? 'failed' : 'accepted' }; if(body[0].envelope.type==='renameSession'){if(options.renameFailure)response={status:'failed'};else nativeTitle=body[0].envelope.payload.title;} }
        rpc([201, id], response);
      }
    });
  });
  harness.relay = `ws://127.0.0.1:${address.port}`;
  const client = new ZcodeRemoteClient(file, dir, harness.relay, credentialFile);
  cleanup.push(() => client.close());
  return { client, calls, wire, file, dir, httpCalls, credentialFile, relay:harness.relay, emit: (value: any) => emit(value), disconnect: () => connection?.terminate() };
}
describe('ZCode desktop remote attachment', () => {
  it('verifies desktop archive state from the native task index even when session metadata stays active', async () => {
    const f = await fixture();
    expect(await f.client.isNativeTaskArchived('sess_original')).toBe(false);
    await f.client.request('session/archive', { sessionId: 'sess_original' });
    expect(await f.client.isNativeTaskArchived('sess_original')).toBe(true);
    expect((await f.client.request('session/read', { sessionId: 'sess_original' })).session.archivedAt).toBeUndefined();
  });
  it('submits an official remote input through V4 with durable native provenance', async () => {
    const f = await fixture();
    await f.client.sendNativeText('sess_original', 'native input', { providerId: 'account:native', modelId: 'native-model' });
    const sent = f.calls.filter(c => c.method === 'sendConversationCommandV4');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[0]).toMatchObject({ workspacePath: f.dir, sessionId: 'sess_original', envelope: {
      sessionId: 'sess_original', type: 'sendText', payload: { text: 'native input', inputOrigin: 'mobile',
        requestedDelivery: 'startNow', modelSelection: { providerId: 'account:native', modelId: 'native-model' } },
    } });
    expect(f.calls.some(c => ['sendPrompt', 'createSession'].includes(c.method))).toBe(false);
  });
  it('ignores replayed faults from an old terminal, but fails on its own workspace bridge fault', async () => {
    const stale=await fixture({staleDegraded:true});
    await expect(stale.client.request('workspace/updateProviderRegistry',{})).resolves.toEqual({});
    expect(stale.calls.some(c=>c.method==='sendPrompt')).toBe(false);
    const own=await fixture({ownDegraded:true});
    await expect(own.client.request('workspace/updateProviderRegistry',{})).rejects.toThrow('远控连接失败');
    expect(own.calls.some(c=>c.method==='sendPrompt')).toBe(false);
  });
  it('names a copied session after input persistence and preserves the native title when resuming', async () => {
    const f=await fixture({v2:true,complete:true});
    await f.client.request('workspace/updateProviderRegistry',{});await f.client.close();
    const adapter=new ZcodeAdapter({modelConfigPath:f.dir,remoteControlFile:f.file});
    for (const resumed of [false, true]) {
      const run=adapter.run({runId:`named-${resumed}`,cwd:f.dir,prompt:'hello',sessionName:resumed?'stale binding':'AA-项目（ZCode）',...(resumed?{sessionId:'sess_new'}:{})});
      const events:AgentEvent[]=[];for await(const event of run.events) events.push(event);
      expect(await run.waitForExit(3000)).toBe(true);
      expect(events.at(-1)).toMatchObject({type:'done'});
    }
    const renames=f.calls.filter(c=>c.method==='sendConversationCommandV4'&&c.args[0].envelope.type==='renameSession');
    expect(renames).toHaveLength(1);
    expect(renames[0]!.args[0]).toMatchObject({sessionId:'sess_new',workspacePath:f.dir,envelope:{type:'renameSession',sessionId:'sess_new',payload:{title:'AA-项目（ZCode）'}}});
    expect(f.calls.findIndex(c=>c.method==='sendConversationCommandV4'&&c.args[0].envelope.type==='renameSession')).toBeGreaterThan(f.calls.findIndex(c=>c.method==='sendPrompt'));
  });
  it('keeps observing an accepted turn when a deferred empty-session title cannot yet be written', async () => {
    const f=await fixture({v2:true,complete:true,renameFailure:true});
    await f.client.request('workspace/updateProviderRegistry',{});await f.client.close();
    const adapter=new ZcodeAdapter({modelConfigPath:f.dir,remoteControlFile:f.file});
    const run=adapter.run({runId:'deferred-title',cwd:f.dir,prompt:'hello',sessionName:'AA-copy'});
    const events:AgentEvent[]=[];for await(const event of run.events)events.push(event);
    expect(await run.waitForExit(3000)).toBe(true);
    expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
    expect(f.calls.filter(c=>c.method==='sendPrompt')).toHaveLength(1);
  });
  it('renames native desktop metadata without creating a session or sending input', async () => {
    const f=await fixture();
    await f.client.request('session/rename',{sessionId:'sess_original',title:'AA-新名字'});
    expect(f.calls.filter(c=>c.method==='readSession')).toHaveLength(2);
    expect(f.calls.some(c=>['createSession','sendPrompt','renameTask'].includes(c.method))).toBe(false);
  });
  it('discovers native desktop models and reasoning without injecting a CLI registry or creating a new session',async()=>{
    const f=await fixture({v2:true});await f.client.request('workspace/updateProviderRegistry',{});await f.client.close();
    expect(await listZcodeRemoteModels(f.file,f.dir,f.credentialFile,f.relay)).toEqual([{value:'account:native/native-model',label:'account:native / Native Model',isDefault:true,reasoningEfforts:[{value:'native-level',label:'Native Level'}],defaultReasoningEffort:'native-level'}]);
    expect(f.calls.some(c=>['createSession','sendPrompt'].includes(c.method))).toBe(false);
  });
  it('creates using the desktop default model, without requiring or overriding it from a local CLI registry',async()=>{
    const f=await fixture({v2:true,complete:true,autoHeaders:true});
    await f.client.request('workspace/updateProviderRegistry',{});await f.client.close();
    const adapter=new ZcodeAdapter({binary:'/must-not-spawn',modelConfigPath:f.dir,remoteControlFile:f.file});
    const run=adapter.run({runId:'native-default',cwd:f.dir,prompt:'hello'});
    const events:AgentEvent[]=[];for await(const event of run.events)events.push(event);
    expect(await run.waitForExit(3000)).toBe(true);
    expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
    const creation=f.calls.find(c=>c.method==='createSession');
    expect(creation?.args[0]).not.toHaveProperty('model');
    expect(creation?.args[0]).toHaveProperty('persistence','immediate');
    expect(f.calls.filter(c=>c.method==='sendPrompt')).toHaveLength(1);
  });
  it('uses current account authorization for V2 links, scopes the device and keeps the login JWT off the relay', async () => {
    const f=await fixture({v2:true});
    await f.client.request('session/resume',{sessionId:'sess_original'});
    expect(f.httpCalls).toEqual([{path:'/api/v1/remote/device',method:'GET',body:''},{path:'/api/v1/remote/token',method:'POST',body:'{"role":"terminal"}'}]);
    expect(f.wire.join('')).not.toContain('PRIVATE_DESKTOP_JWT');
    expect(JSON.stringify(f.calls)).not.toContain('PRIVATE_DESKTOP_JWT');
  });
  it('rejects a V2 device outside the logged-in account before minting a terminal token', async () => {
    const f=await fixture({v2:true,foreignDevice:true});
    await expect(f.client.request('session/resume',{sessionId:'sess_original'})).rejects.toThrow('authorize');
    expect(f.httpCalls).toHaveLength(1);expect(f.calls).toHaveLength(0);
  });
  it.each([false, true])('routes the real adapter through desktop RPC, preserves streaming and stops only its own execution (stop=%s)', async stop => {
    const f = await fixture(stop ? { wait: true } : { complete: true });
    await f.client.request('workspace/updateProviderRegistry', {}); await f.client.close();
    await writeFile(join(f.dir, 'config.json'), JSON.stringify({ model: 'test/model', provider: { test: { kind: 'openai', models: { model: {} } } } }));
    const adapter = new ZcodeAdapter({ binary: '/must-not-spawn-zcode', dataDir: f.dir, modelConfigPath: f.dir, remoteControlFile: f.file });
    const run = adapter.run({ runId: 'adapter-remote', sessionId: 'sess_original', cwd: f.dir, prompt: 'hello', accessMode: 'read-only' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) { events.push(event); if (stop && event.type === 'text') await run.stop(); }
    expect(await run.waitForExit(3000)).toBe(true);
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('REMOTE_OK');
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess_original', terminationReason: stop ? 'interrupted' : 'normal' });
    expect(f.calls.filter(c => c.method === 'sendPrompt')).toHaveLength(1);
    expect(f.calls.find(c => c.method === 'setMode')?.args[0].mode).toBe('plan');
    if (stop) expect(f.calls.at(-1)?.args[0].envelope.payload.expectedForegroundExecutionId).toBe('exec-own');
  });
  it('authenticates, attaches exact workspace, subscribes before sending and keeps provider credentials local', async () => {
    const f = await fixture();
    await f.client.request('workspace/updateProviderRegistry', { registry: { secret: 'PROVIDER_SECRET_MUST_STAY_LOCAL' } });
    const model = { providerId: 'actual-provider', modelId: 'actual-model' };
    expect(await f.client.request('session/resume', { sessionId: 'sess_original' })).toEqual({ session: { sessionId: 'sess_original' } });
    await f.client.request('session/setModel', { sessionId: 'sess_original', model, runtimeModel: { provider: { key: 'PROVIDER_SECRET_MUST_STAY_LOCAL' } } });
    await f.client.request('session/subscribe', { sessionId: 'sess_original' });
    await expect(f.client.request('session/send', { sessionId: 'sess_original', inputId: 'own-input', content: 'hello', runtimeModel: { model, provider: { key: 'PROVIDER_SECRET_MUST_STAY_LOCAL' } } })).resolves.toEqual({ accepted: true });
    expect(f.calls.map(c => c.method)).toEqual(['helloConversationV4', 'initializeConversationV4', 'resumeSession', 'setModel', 'onDynamicSessionEvent', 'sendPrompt']);
    expect(f.calls.at(-1)?.args).toEqual([{ workspacePath: f.dir, sessionId: 'sess_original', inputId: 'own-input', content: 'hello', clientMode: 'web-remote-replayable', modelSelection: model }]);
    expect(f.wire.join('')).not.toContain('PROVIDER_SECRET_MUST_STAY_LOCAL');
    // Decode wire calls too: secrets could otherwise hide inside base64.
    expect(JSON.stringify(f.calls)).not.toContain('PROVIDER_SECRET_MUST_STAY_LOCAL');
    const events: any[] = []; f.client.onNotification((method, event) => events.push({ method, event }));
    f.client.onInteraction=vi.fn();
    f.emit({type:'providerRuntimeHeaders.request',request:{sessionId:'sess_original'}});
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'turn.started', turnId: 'other', payload: { inputId: 'someone-else', foregroundExecutionId: 'exec-other' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'model.streaming', turnId: 'other', payload: { delta: 'must-ignore' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'turn.started', turnId: 'own', payload: { inputId: 'own-input', foregroundExecutionId: 'exec-own' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'model.streaming', turnId: 'own', payload: { delta: 'visible' } } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events).toHaveLength(2);
    expect(f.client.onInteraction).not.toHaveBeenCalled();
    await f.client.request('session/stop', { sessionId: 'sess_original' });
    expect(f.calls.at(-1)?.args[0].envelope.payload).toEqual({ expectedForegroundExecutionId: 'exec-own' });
  });
  it('rejects a different desktop workspace without executing a model request', async () => {
    const f = await fixture({ workspace: '/different-project' });
    await expect(f.client.request('session/resume', { sessionId: 'sess_a' })).rejects.toThrow('远控连接失败');
    expect(f.calls).toHaveLength(0);
  });
  it('redacts authentication errors and does not fall back to another runtime', async () => {
    const f = await fixture({ error: true });
    await expect(f.client.request('session/resume', { sessionId: 'sess_a' })).rejects.toThrow('未改用独立 Agent');
    expect(f.calls).toHaveLength(0);
  });
  it('never replays an unacknowledged send after disconnection', async () => {
    const f = await fixture({ closeOnSend: true });
    await f.client.request('session/subscribe', { sessionId: 'sess_a' });
    await expect(f.client.request('session/send', { sessionId: 'sess_a', inputId: 'input-a', content: 'hello' })).rejects.toThrow('未自动重发');
    expect(f.calls.filter(c => c.method === 'sendPrompt')).toHaveLength(1);
  });
  it('stops a mirrored desktop input through the adapter with its exact foreground identity and no prompt', async () => {
    const f = await fixture({ nativeStop: true }); await f.client.request('workspace/updateProviderRegistry', {}); await f.client.close();
    const adapter = new ZcodeAdapter({ remoteControlFile: f.file, modelConfigPath: f.dir });
    expect(await adapter.stopNativeTurn('sess_original', 'msg-desktop', f.dir)).toBe(true);
    const stop = f.calls.find(c => c.method === 'sendConversationCommandV4');
    expect(stop?.args[0]).toMatchObject({ sessionId: 'sess_original', envelope: { type: 'stop', payload: { expectedForegroundExecutionId: 'exec-desktop' } } });
    expect(f.calls.filter(c => c.method === 'sendConversationCommandV4')).toHaveLength(1);
    expect(f.calls.find(c => c.method === 'readSessionEvents')?.args[0]).toMatchObject({ afterSeq: 5000, limit: 10000 });
    expect(f.calls.some(c => ['sendPrompt', 'createSession', 'resumeSession', 'setMode', 'setModel'].includes(c.method))).toBe(false);
  });
  it.each(['missingExecution', 'wrongMessage', 'changedTurn', 'rejectStop'] as const)('refuses unconfirmed native stop (%s) without an unscoped fallback or retry', async failure => {
    const f = await fixture({ nativeStop: true, [failure]: true });
    await expect(f.client.request('session/stopNative', { sessionId: 'sess_original', turnId: 'msg-desktop' })).rejects.toThrow();
    expect(f.calls.filter(c => c.method === 'sendConversationCommandV4')).toHaveLength(failure === 'rejectStop' ? 1 : 0);
    expect(f.calls.some(c => ['stopSession', 'sendPrompt', 'resumeSession'].includes(c.method))).toBe(false);
  });
  it('does nothing when the desktop task has already completed', async () => {
    const f = await fixture({ nativeStop: true, idle: true });
    expect(await f.client.request('session/stopNative', { sessionId: 'sess_original', turnId: 'msg-desktop' })).toEqual({ stopped: false });
    expect(f.calls.some(c => c.method === 'sendConversationCommandV4')).toBe(false);
  });
  it('refuses stop before an owned execution identity is known', async () => {
    const f = await fixture();
    await expect(f.client.request('session/stop', { sessionId: 'sess_a' })).rejects.toThrow('未停止其他任务');
    expect(f.calls.some(c => c.method === 'sendConversationCommandV4')).toBe(false);
  });
  it('rejects public-readable and symlinked credential files', async () => {
    const f = await fixture(); await f.client.close();
    await chmod(f.file, 0o644); await expect(readZcodePairing(f.file)).rejects.toThrow('权限为 600');
    await chmod(f.file, 0o600); const link = join(f.dir, 'symlink'); await symlink(f.file, link);
    await expect(readZcodePairing(link)).rejects.toThrow();
  });
});
describe('ZCode wire compatibility and bounds', () => {
  it('uses the upstream Channel serialization and HMAC proof golden vector', () => {
    expect(encodeRpc([100, 1, 'zcode-agent', 'x'], [{}]).toString('hex')).toBe('040406640601010b7a636f64652d6167656e74010178040105027b7d');
    const p = parseZcodePairing('https://zcode.z.ai/remote/v4?sid=device-1&hash=dGVzdF9oYXNo&t=1');
    expect(zcodeAuthProof(p, 'nonce-1')).toBe('YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU');
    expect(() => parseZcodePairing('https://evil.example/remote/v4?sid=a&hash=b&t=1')).toThrow();
    expect(crc32(Buffer.from('123456789'))).toBe('cbf43926');
    expect(() => decodeRpc(Buffer.from([4, 255, 255, 255, 255, 255]))).toThrow();
  });
  it('reassembles bounded fragmented frames, ACKs duplicates, and rejects gaps/corruption', () => {
    const sender = new RemoteFrames('bridge'), receiver = new RemoteFrames('bridge');
    const bytes = Buffer.from('hello'.repeat(150000)), frames = sender.encode(bytes);
    expect(receiver.accept(frames[0])).toEqual({});
    expect(receiver.accept(frames[1]).bytes).toEqual(bytes);
    expect(receiver.accept(frames[1]).ack?.ackMessageSeq).toBe(1);
    const gap = new RemoteFrames('bridge'); expect(() => gap.accept(frames[1])).toThrow('gap');
    const broken = new RemoteFrames('bridge'), frame = new RemoteFrames('bridge').encode(Buffer.from('hello'))[0];
    expect(() => broken.accept({ ...frame, dataBase64: Buffer.from('other').toString('base64') })).toThrow('checksum');
  });
});
