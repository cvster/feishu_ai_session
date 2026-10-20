import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ZcodeRemoteClient, parseZcodePairing, readZcodePairing, zcodeAuthProof } from '../../../src/agent/zcode/remote-client';
import { RemoteFrames, encodeRpc, decodeRpc, crc32 } from '../../../src/agent/zcode/remote-wire';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import type { AgentEvent } from '../../../src/agent/types';

const harness = vi.hoisted(() => ({ relay: '' }));
vi.mock('../../../src/agent/zcode/remote-client', async importOriginal => {
  const real = await importOriginal<typeof import('../../../src/agent/zcode/remote-client')>();
  return { ...real, ZcodeRemoteClient: class extends real.ZcodeRemoteClient {
    constructor(file: string, cwd: string, relay?: string) { super(file, cwd, relay ?? harness.relay); }
  } };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { error?: boolean; workspace?: string; closeOnSend?: boolean; complete?: boolean; wait?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-remote-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pair.link');
  await writeFile(file, 'https://zcode.z.ai/remote/v4?sid=device-1&hash=dGVzdF9oYXNo&t=123&app_version=3.10.2', { mode: 0o600 });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(async () => { for (const s of server.clients) s.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('invalid fixture');
  const calls: Array<{ method: string; args: any }> = [], wire: string[] = [];
  let emit!: (value: any) => void, connection: WebSocket | undefined, subscribeId: number | undefined;
  server.on('connection', socket => {
    connection = socket;
    let frames: RemoteFrames;
    const send = (p: any) => socket.send(JSON.stringify(p));
    const payload = (p: any) => send({ type: 'data', payload: p });
    const rpc = (header: unknown[], body?: unknown) => { for (const frame of frames.encode(encodeRpc(header, body))) payload(frame); };
    emit = event => rpc([204, subscribeId], event);
    socket.on('message', raw => {
      wire.push(raw.toString());
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth_init') send({ type: 'auth_challenge', nonce: 'nonce-1' });
      if (message.type === 'auth_response') {
        expect(message.proof).toBe('YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU');
        send(options.error ? { type: 'error', code: 'AUTH_FAILED', message: 'secret-upstream-error' } : { type: 'auth_ack', device_sid: 'device-1', pair_status: 'matched' });
      }
      if (message.type !== 'data') return;
      const p = message.payload;
      if (p.zcode_type === 'bootstrap-request') payload({ zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
        result: { workspaces: [{ workspacePath: options.workspace ?? dir, workspaceKey: options.workspace ?? dir, kind: 'local' }], tasks: [] } });
      if (p.zcode_type === 'workspace-bridge-open') {
        frames = new RemoteFrames(p.bridgeSessionId);
        rpc([200]); // Host initializes before bridge-ready; must not lose it.
        payload({ zcode_type: 'workspace-bridge-ready', requestId: p.requestId, bridge: { bridgeSessionId: p.bridgeSessionId, kind: 'local', workspacePath: dir } });
      }
      if (p.zcode_type === 'rpc-frame' || p.zcode_type === 'rpc-frame-ack') {
        const result = frames.accept(p); if (result.ack) payload(result.ack); if (!result.bytes) return;
        const { header: [kind, id, channel, method], body } = decodeRpc(result.bytes);
        expect(channel).toBe('zcode-agent');
        calls.push({ method, args: body });
        if (kind === 102) { subscribeId = id; emit({ type: 'snapshot', snapshot: { session: { sessionId: body.sessionId } } }); return; }
        let response: any = {};
        if (method === 'helloConversationV4') response = { kind: 'hello', protocolVersion: 2, clientMode: 'web-remote-replayable' };
        if (method === 'resumeSession' || method === 'createSession') response = { session: { sessionId: body[0].sessionId ?? 'sess_new' } };
        if (method === 'sendPrompt') {
          if (options.closeOnSend) { socket.terminate(); return; }
          response = { accepted: true };
          if (options.complete || options.wait) {
            emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 1, type: 'turn.started', turnId: 'turn-own', payload: { inputId: body[0].inputId, foregroundExecutionId: 'exec-own' } } });
            emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 2, type: 'model.streaming', turnId: 'turn-own', payload: { kind: 'text_delta', delta: 'REMOTE_OK' } } });
            if (options.complete) emit({ type: 'session.event', event: { sessionId: body[0].sessionId, seq: 3, type: 'turn.completed', turnId: 'turn-own', payload: { inputId: body[0].inputId, response: 'REMOTE_OK', resultType: 'success' } } });
          }
        }
        if (method === 'sendConversationCommandV4') response = { status: 'accepted' };
        rpc([201, id], response);
      }
    });
  });
  harness.relay = `ws://127.0.0.1:${address.port}`;
  const client = new ZcodeRemoteClient(file, dir, harness.relay);
  cleanup.push(() => client.close());
  return { client, calls, wire, file, dir, emit: (value: any) => emit(value), disconnect: () => connection?.terminate() };
}
describe('ZCode desktop remote attachment', () => {
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
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'turn.started', turnId: 'other', payload: { inputId: 'someone-else', foregroundExecutionId: 'exec-other' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'model.streaming', turnId: 'other', payload: { delta: 'must-ignore' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'turn.started', turnId: 'own', payload: { inputId: 'own-input', foregroundExecutionId: 'exec-own' } } });
    f.emit({ type: 'session.event', event: { sessionId: 'sess_original', type: 'model.streaming', turnId: 'own', payload: { delta: 'visible' } } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events).toHaveLength(2);
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
