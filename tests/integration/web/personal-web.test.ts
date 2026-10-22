import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { fixture, cleanups } from '../../helpers/worker-fixture';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ToolRegistry } from '../../../src/tools/types';
import { WorkerInbox } from '../../../src/worker/inbox';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { Controls } from '../../../src/commands';
import { PersonalSessionService } from '../../../src/web/service';
import { startBridgeWeb } from '../../../src/web/server';
import { configureWeb } from '../../../src/web/config';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { enqueuePersonalInput } from '../../../src/bot/intake-queue';
import { initialState, reduce } from '../../../src/card/run-state';
import { startWorkerReplies } from '../../../src/worker/replies';
import { startNativeTurnSync } from '../../../src/bot/native-turn-sync';
import { startWorkerNameSync } from '../../../src/bot/tool-name-sync';

async function harness(tool: 'codex' | 'zcode' | 'kilo' = 'kilo') {
  const native = { nativeId: 'native', name: 'AA-web', cwd: '/project', createdAtMs: 1, updatedAtMs: 2 };
  const conversation = { id: 'native', name: native.name, cwd: native.cwd, archived: false, turns: [{ id: 'desktop-1', input: '来自桌面', bridge: false,
    createdAtMs: 10, state: reduce(reduce(initialState, { type: 'text', delta: '原生回答' }), { type: 'done', terminationReason: 'normal' }) }] };
  const provider = { list: async () => [native], nativeNames: true, conversation: vi.fn(async () => conversation),
    history: async () => undefined, rename: async (_id: string, name: string) => { native.name = name; } };
  const h = await fixture(tool, provider);
  h.options.cwd = native.cwd;
  if (tool === 'codex') { h.options.threadId = 'native'; h.options.sessionId = undefined; }
  const inbox = new WorkerInbox(join(h.dir, 'inbox.json')); await inbox.load();
  const bindings = new ToolBindingStore(join(h.dir, 'bindings.json')); await bindings.load();
  const catalog = new SessionCatalog(join(h.dir, 'catalog.json')); await catalog.load();
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true }, accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls = { profile: 'test', profileConfig: profile, toolBindings: bindings, ownerRefreshState: 'ok', botOwnerId: 'ou_owner',
    workerInbox: inbox, workerRuntimes: new Map([[tool, { inbox }]]), cfg: { preferences: { messageReply: 'card', messageReplyMigrated: true } } } as unknown as Controls;
  bindings.enforcePersonalUniqueness(catalog, 'cli_test', () => h.client.sourceId);
  bindings.set('oc_group', { toolId: tool, sourceId: h.client.sourceId, nativeId: 'native', name: 'AA-web' });
  catalog.upsertActive({ scopeId: 'oc_group', agentId: tool, cwdRealpath: native.cwd, sourceId: h.client.sourceId, botAppId: 'cli_test', policyFingerprint: 'fp', sessionId: tool === 'codex' ? undefined : 'native', threadId: tool === 'codex' ? 'native' : undefined });
  const registry = new ToolRegistry(); registry.register({ id: tool, sourceId: h.client.sourceId, label: 'Tool from manifest', agent: h.adapter,
    listSessions: () => h.client.listSessions(), sessions: { historyPath: async () => undefined, rename: (id, name) => h.client.renameSession(id, name), archive: async () => {} } });
  controls.toolRegistry = registry;
  let group = 'AA-web';
  const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_web' } }));
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply' } }));
  const channel = { getChatMode: vi.fn(async () => 'group'), getChatInfo: vi.fn(async () => ({ name: group })), createCard: vi.fn(async () => ({ cardId: 'card' })), updateCardById: vi.fn(async () => {}),
    rawClient: { im: { v1: { message: { create, reply, patch: vi.fn(async () => ({ code: 0 })) }, chat: { update: vi.fn(async ({ data }: { data: { name: string } }) => { group = data.name; return { code: 0 }; }) } } } } } as unknown as LarkChannel;
  const activeRuns = new ActiveRuns();
  let queued!: Promise<void>;
  const pending = new PendingQueue(5, (scope, batch) => {
    queued = (async () => {
      await h.client.submit({ requestKey: JSON.stringify([scope, batch.map(m => m.messageId)]), options: { ...h.options, sessionId: tool === 'codex' ? undefined : 'native', threadId: tool === 'codex' ? 'native' : undefined, initialSessionId: undefined,
        prompt: batch.map(m => m.content).join('\n'), delivery: { ...h.options.delivery!, messageIds: batch.map(m => m.messageId) } } });
      await inbox.reconcile(await h.client.list()); inbox.releaseQueued(scope, batch);
    })();
  }); cleanups.push(async () => { pending.cancelAll(); await queued; });
  const names = await startWorkerNameSync({ channel, controls, catalog, profileDir: h.dir, intervalMs: 60_000 }); await names.tick(); cleanups.push(async () => { await names.stop(); await catalog.flush(); await bindings.flush(); await inbox.flush(); });
  const enqueue = vi.fn((msg: NormalizedMessage) => enqueuePersonalInput({ agent: h.adapter, controls, activeRuns, pending, scope: msg.chatId, msg }));
  const servicePath = join(h.dir, 'web-receipts.json');
  const makeService = () => new PersonalSessionService({ controls, catalog, channel, path: servicePath, enqueue,
    rename: (id, scope, nativeId, name) => names.rename(id, scope, nativeId, name) });
  const service = makeService(); await service.load();
  const socket = createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r)); const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()));
  const configPath = join(h.dir, 'web.json'), { secret } = await configureWeb(configPath, '127.0.0.1', port);
  const web = (await startBridgeWeb({ configPath, service, pollMs: 30 }))!; cleanups.push(() => web.close());
  let cookie = '';
  const request = (path: string, value?: unknown, headers = {}) => fetch(web.url + path, { method: value === undefined ? 'GET' : 'POST', headers: {
    Cookie: cookie, Origin: web.url, 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const login = async () => { const response = await request('/api/login', { secret }); expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!; };
  const sessions = new SessionStore(join(h.dir, 'sessions.json')); await sessions.load();
  const replies = await startWorkerReplies({ adapter: h.adapter, channel, controls, catalog, sessions, activeRuns, statePath: join(h.dir, 'replies.json'), intervalMs: 60_000 }); cleanups.push(() => replies.stop());
  return { ...h, bindings, catalog, controls, inbox, service, makeService, request, login, web, secret, channel, create, enqueue, names, native, conversation, provider, replies, activeRuns, group: (name: string) => { group = name; } };
}

it.each(['codex', 'zcode', 'kilo'] as const)('syncs Web/group/native messages through the same durable %s worker, with retries and SSE reconnect', async tool => {
  const h = await harness(tool); await h.login();
  const rows: any = await (await h.request('/api/sessions')).json(); expect(rows).toHaveLength(1); const id = rows[0].id;
  expect(rows[0]).toMatchObject({ tool: 'Tool from manifest', project: 'project', canSend: true, canRename: true });
  const input = { requestId: 'web-unique-request-01', text: '/exit is plain user input here' };
  const [a, b] = await Promise.all([h.request('/api/sessions/' + id + '/send', input), h.request('/api/sessions/' + id + '/send', input)]);
  expect([a.status, b.status]).toEqual([202, 202]); expect(h.create).toHaveBeenCalledOnce(); expect(h.enqueue).toHaveBeenCalledOnce();
  expect(JSON.parse((h.create.mock.calls[0] as any)[0].data.content)).toEqual({ text: '来自网页\n' + input.text });
  await vi.waitFor(() => expect(h.calls).toHaveLength(1)); expect(h.calls[0]?.prompt).toBe(input.text);
  await h.replies.runNow(); expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls)).toContain('before restart');
  const abort = new AbortController(); const response = await fetch(h.web.url + '/api/events?session=' + id, { headers: { Cookie: (await h.request('/api/login', { secret: h.secret })).headers.get('set-cookie')!.split(';')[0]! }, signal: abort.signal });
  const reader = response.body!.getReader(); let streamed = '';
  await vi.waitFor(async () => { if (!streamed.includes('before restart')) streamed += new TextDecoder().decode((await reader.read()).value); expect(streamed).toContain('before restart'); });
  expect(streamed).toContain('来自桌面'); expect(streamed).toContain('原生回答'); abort.abort(); await reader.cancel().catch(() => {});
  expect(h.stop).not.toHaveBeenCalled(); h.finish();
  await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed')); await h.replies.runNow();
  expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls)).toContain('after restart');
  const read: any = await (await h.request('/api/sessions/' + id)).json(); expect(read.turns.find((t: any) => t.id.startsWith('job:'))).toMatchObject({ input: input.text, answer: 'before restart\nafter restart', status: 'completed' });
  const restarted = h.makeService(); await restarted.load(); await restarted.send(id, input.requestId, input.text); expect(h.create).toHaveBeenCalledOnce(); expect(h.calls).toHaveLength(1);
  expect((await h.request('/api/sessions/' + id + '/send', { ...input, text: 'changed' })).status).toBe(409);
  const groupMessage = { ...h.inbox.receipts('oc_group')[0]!.message, messageId: 'om_group', content: '群内输入' };
  await h.enqueue(groupMessage); await vi.waitFor(() => expect(h.calls).toHaveLength(2));
  const groupRead = await h.service.read(id); expect(groupRead.turns.some(t => t.input === '群内输入')).toBe(true);
  let clock = Date.now();
  const mirror = await startNativeTurnSync({ toolId: tool, displayName: 'Generic worker', channel: h.channel, controls: h.controls, catalog: h.catalog,
    sourceId: h.client.sourceId, statePath: join(h.dir, 'native-mirror.json'), intervalMs: 60_000, now: () => clock,
    reader: { read: sid => h.client.conversation(sid), close: async () => {} } });
  try {
    await mirror.runNow(); const count = h.create.mock.calls.length; clock += 100;
    h.conversation.turns.push({ id: 'desktop-new', input: '新的原生输入', bridge: false, createdAtMs: clock,
      state: reduce(reduce(initialState, { type: 'text', delta: '新的原生回答' }), { type: 'done', terminationReason: 'normal' }) });
    await mirror.runNow(); expect(h.create.mock.calls.length).toBeGreaterThan(count);
    expect(JSON.stringify(h.create.mock.calls.slice(count))).toContain('新的原生输入');
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).toContain('新的原生回答');
    expect((await h.service.read(id)).turns.some(t => t.input === '新的原生输入' && t.answer === '新的原生回答')).toBe(true);
  } finally { await mirror.stop(); }

});

it('coordinates Web/native/group names without old snapshots reverting an explicit rename', async () => {
  const h = await harness(); await h.login(); const id = (await h.service.list())[0]!.id;
  expect((await h.request('/api/sessions/' + id + '/rename', { name: 'AA-Web改名' })).status).toBe(200);
  await h.names.tick(); await h.names.tick(); expect(h.native.name).toBe('AA-Web改名'); expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-Web改名' });
  h.group('AA-群改名'); await h.names.tick(); expect(h.native.name).toBe('AA-群改名');
  await h.names.tick(); h.native.name = 'AA-工具改名'; await h.names.tick(); expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-工具改名' });
  expect((await h.service.list())[0]?.name).toBe('AA-工具改名');
});

it('retains offline routes but excludes shared, archived and changed-account routes and fails closed on writes', async () => {
  const h = await harness(); const id = (await h.service.list())[0]!.id;
  h.bindings.set('oc_shared', { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'shared', linkedSource: { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'shared' } });
  expect(await h.service.list()).toHaveLength(1);
  h.controls.toolRegistry!.remove('kilo');
  await expect(h.service.send(id, 'offline-request-01', 'hello')).rejects.toMatchObject({ status: 503 });
  expect((await h.service.list())[0]).toMatchObject({ online: false, canSend: false }); expect(h.create).not.toHaveBeenCalled();
  h.catalog.archiveScope('oc_group', 'native'); expect(await h.service.list()).toHaveLength(0);
  await expect(h.service.read(id)).rejects.toMatchObject({ status: 404 });
});

it('recovers an ambiguous group post with its UUID and never enqueues after binding changed', async () => {
  const h = await harness(); const id = (await h.service.list())[0]!.id;
  h.create.mockRejectedValueOnce(new Error('ack lost'));
  await expect(h.service.send(id, 'ambiguous-request-1', 'hello')).rejects.toThrow('ack lost');
  await h.service.send(id, 'ambiguous-request-1', 'hello');
  expect((h.create.mock.calls[0] as any)[0].data.uuid).toBe((h.create.mock.calls[1] as any)[0].data.uuid); expect(h.enqueue).toHaveBeenCalledOnce();
  h.create.mockImplementationOnce(async () => { h.catalog.archiveScope('oc_group', 'native'); return { code: 0, data: { message_id: 'om_late' } }; });
  await expect(h.service.send(id, 'rebound-request-02', 'another')).rejects.toMatchObject({ status: 409 }); expect(h.enqueue).toHaveBeenCalledOnce();
});

it('requires cookie auth and same origin, revokes on owner/config changes, and does not reveal tool secrets', async () => {
  const h = await harness(); expect((await h.request('/api/sessions')).status).toBe(401);
  expect((await h.request('/api/login', { secret: h.secret }, { Origin: 'https://evil.test' })).status).toBe(403);
  expect((await h.request('/api/login', { secret: 'wrong' })).status).toBe(401);
  await h.login(); const text = await (await h.request('/api/sessions')).text(); expect(text).not.toContain('cli_test'); expect(text).not.toContain('token'); expect(text).not.toContain('local-kilo');
  h.controls.botOwnerId = 'ou_other'; expect((await h.request('/api/sessions')).status).toBe(401); h.controls.botOwnerId = 'ou_owner';
  await configureWeb(join(h.dir, 'web.json'), '127.0.0.1', Number(new URL(h.web.url).port)); expect((await h.request('/api/sessions')).status).toBe(401);
});
