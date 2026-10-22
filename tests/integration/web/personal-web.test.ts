import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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
import { WebSessionControls, type WebControlElement } from '../../../src/web/controls';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createRootConfig, saveRootConfig, runtimeProfileConfig } from '../../../src/config/profile-store';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { enqueuePersonalInput } from '../../../src/bot/intake-queue';
import { initialState, reduce } from '../../../src/card/run-state';
import { startWorkerReplies } from '../../../src/worker/replies';
import { startNativeTurnSync } from '../../../src/bot/native-turn-sync';
import { configureGroupNotifications } from '../../../src/bot/group-notifications';
import { startWorkerNameSync } from '../../../src/bot/tool-name-sync';
import { recordRunSessionEvent } from '../../../src/bot/run-flow';
import { capabilityForTool } from '../../../src/agent/capability';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { WebConfig } from '../../../src/web/config';

async function harness(tool: 'codex' | 'zcode' | 'kilo' | 'claude' | 'dsh' = 'kilo', host = '127.0.0.1', access: Pick<WebConfig, 'additionalHosts' | 'trustedNetworks'> = {}, authoritative = false) {
  const native = { nativeId: 'native', name: 'AA-web', cwd: '/project', createdAtMs: 1, updatedAtMs: 2, archived: false };
  const conversation = { id: 'native', name: native.name, cwd: native.cwd, archived: false, turns: [{ id: 'desktop-1', input: '来自桌面', bridge: false,
    createdAtMs: 10, state: reduce(reduce(initialState, { type: 'text', delta: '原生回答' }), { type: 'done', terminationReason: 'normal' }) }] };
  const copies: typeof native[] = [];
  const provider = { listAuthoritative: authoritative, list: vi.fn(async () => [native, ...copies]), nativeNames: true, conversation: vi.fn(async () => conversation),
    history: async () => undefined, rename: async (_id: string, name: string) => { native.name = name; }, archive: vi.fn(async () => { native.archived = true; }),
    fork: vi.fn(async () => { const copy = { ...native, nativeId: 'native-fork', name: 'AA-web（分叉）' }; copies.push(copy); return copy; }) };
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
    listSessions: () => h.client.listSessions(), sessions: { historyPath: async () => undefined, rename: (id, name) => h.client.renameSession(id, name), nativeArchive: true, archive: id => h.client.archiveSession(id), fork: id => h.client.forkSession(id) } });
  controls.toolRegistry = registry;
  controls.configPath = join(h.dir, 'config.json');
  controls.refreshOwner = async () => {};
  const rootConfig = createRootConfig('test', profile); await saveRootConfig(rootConfig, controls.configPath);
  controls.cfg = runtimeProfileConfig(rootConfig, 'test');
  const sessions = new SessionStore(join(h.dir, 'sessions.json')); await sessions.load();
  const workspaces = new WorkspaceStore(join(h.dir, 'workspaces.json')); await workspaces.load();
  let group = 'AA-web';
  const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_web' } }));
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply' } }));
  const send = vi.fn(async () => ({ messageId: 'om_command' }));
  const channel = { send, listChats: async () => [{ id: 'oc_group', name: group }], getChatMode: vi.fn(async () => 'group'), getChatInfo: vi.fn(async () => ({ name: group })), createCard: vi.fn(async () => ({ cardId: 'card' })), updateCardById: vi.fn(async () => {}),
    rawClient: { im: { v1: { message: { create, reply, patch: vi.fn(async () => ({ code: 0 })) }, chat: { get: vi.fn(async () => ({ code: 0, data: { name: group, chat_mode: 'group' } })), delete: vi.fn(async () => ({ code: 0 })), update: vi.fn(async ({ data }: { data: { name: string } }) => { group = data.name; return { code: 0 }; }) } } } } } as unknown as LarkChannel;
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
  const webControls = new WebSessionControls(async (scope, owner) => ({ channel, scope, chatMode: 'group', sessions, sessionCatalog: catalog,
    workspaces, activeRuns, pending, agent: h.adapter, controls,
    msg: { messageId: 'web-control', chatId: scope, chatType: 'group', senderId: owner, content: '', resources: [], mentions: [],
      mentionedBot: true, mentionAll: false, rawContentType: 'interactive', createTime: Date.now() } }));
  const servicePath = join(h.dir, 'web-receipts.json');
  const makeService = () => new PersonalSessionService({ controls, catalog, channel, path: servicePath, enqueue,
    rename: (id, scope, nativeId, name) => names.rename(id, scope, nativeId, name),
    control: (id, scope, owner, action, values) => webControls.execute(id, scope, owner, action, values) });
  const service = makeService(); await service.load();
  const socket = createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r)); const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()));
  const configPath = join(h.dir, 'web.json'), { secret } = await configureWeb(configPath, '127.0.0.1', port);
  if (host !== '127.0.0.1' || Object.keys(access).length) await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), host, ...access }));
  const web = (await startBridgeWeb({ configPath, service, pollMs: 30 }))!; cleanups.push(() => web.close());
  let cookie = '';
  const request = (path: string, value?: unknown, headers = {}) => fetch(web.url + path, { method: value === undefined ? 'GET' : 'POST', headers: {
    Cookie: cookie, Origin: web.url, 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const login = async () => { const response = await request('/api/login', { secret }); expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''; };
  const replies = await startWorkerReplies({ adapter: h.adapter, channel, controls, catalog, sessions, activeRuns, statePath: join(h.dir, 'replies.json'), intervalMs: 60_000 }); cleanups.push(() => replies.stop());
  controls.workerRuntimes!.get(tool)!.replies = replies;
  return { ...h, bindings, catalog, controls, sessions, inbox, service, makeService, request, login, web, secret, configPath, webControls, workspaces, send, channel, create, enqueue, names, native, conversation, provider, replies, activeRuns, group: (name: string) => { group = name; } };
}

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('replays %s history once and keeps one reply writer when a task refreshes the binding', async tool => {
  const h = await harness(tool), original = h.catalog.entries()[0]!;
  h.catalog.upsertActive({ ...original, now: Date.now(), recentTurnReplayCount: 3 });
  const boundAt = h.catalog.entries()[0]!.boundAt;
  const startMirror = () => startNativeTurnSync({ toolId: tool, displayName: 'Generic worker', channel: h.channel, controls: h.controls,
    catalog: h.catalog, sourceId: h.client.sourceId, statePath: join(h.dir, 'native-mirror.json'), intervalMs: 60_000,
    reader: { read: sid => h.client.conversation(sid), close: async () => {} } });
  let mirror = await startMirror();
  try {
    expect(h.catalog.entries()[0]!.recentTurnReplayCount).toBeUndefined();
    const historicalSends = h.create.mock.calls.length;
    const historicalCard = JSON.stringify(vi.mocked(h.channel.createCard).mock.calls);
    expect(historicalCard).toContain('原生回答');
    const id = (await h.service.list())[0]!.id;
    await h.service.send(id, 'single-reply-request-01', '本轮只回复一次');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.conversation.turns.push({ id: 'worker-current', input: '本轮只回复一次', bridge: true, createdAtMs: Date.now() + 1,
      state: { ...initialState, terminal: 'running', blocks: [{ kind: 'text', content: 'worker answer', streaming: true }] } });
    recordRunSessionEvent({ scopeId: 'oc_group', botAppId: 'cli_test', sessions: h.sessions, sessionCatalog: h.catalog,
      capability: capabilityForTool(tool, h.controls.profileConfig), policy: { cwdRealpath: h.native.cwd, policyFingerprint: 'fp' } as RunPolicyAllow,
      event: { type: 'system', ...(tool === 'codex' ? { threadId: 'native' } : { sessionId: 'native' }) } });
    await h.replies.runNow(); await mirror.runNow();
    expect(h.catalog.entries()[0]!.boundAt).toBe(boundAt);
    expect(h.catalog.entries()[0]!.recentTurnReplayCount).toBeUndefined();
    // Only the Web input adds a create; the answer belongs to worker reply().
    expect(h.create).toHaveBeenCalledTimes(historicalSends + 1);
    expect(vi.mocked(h.channel.rawClient.im.v1.message.reply).mock.calls.filter(([r]) => r?.data.msg_type === 'interactive')).toHaveLength(1);
    h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
    h.conversation.turns.at(-1)!.state.terminal = 'done';
    await h.replies.runNow(); await mirror.runNow();
    await mirror.stop(); mirror = await startMirror(); await mirror.runNow();
    expect(h.create).toHaveBeenCalledTimes(historicalSends + 1);
    expect(vi.mocked(h.channel.rawClient.im.v1.message.reply).mock.calls.filter(([r]) => r?.data.msg_type === 'interactive')).toHaveLength(1);
  } finally { await mirror.stop(); }
});

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
  const abort = new AbortController(); const response = await fetch(h.web.url + '/api/events?session=' + id, { signal: abort.signal });
  const reader = response.body!.getReader(); let streamed = '';
  await vi.waitFor(async () => { if (!streamed.includes('before restart')) streamed += new TextDecoder().decode((await reader.read()).value); expect(streamed).toContain('before restart'); });
  expect(streamed).toContain('来自桌面'); expect(streamed).toContain('原生回答'); abort.abort(); await reader.cancel().catch(() => {});
  expect(h.stop).not.toHaveBeenCalled(); h.finish();
  await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed')); await h.replies.runNow();
  expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls)).toContain('after restart');
  const read: any = await (await h.request('/api/sessions/' + id)).json(); expect(read.turns.find((t: any) => t.id.startsWith('job:'))).toMatchObject({ input: input.text, requestIds: [input.requestId], answer: 'before restart\nafter restart', status: 'completed' });
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

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('uses live group names for %s sidebar even with stale bindings and unavailable native name sync', async tool => {
  const h = await harness(tool);
  const bindings = h.bindings;
  const original = bindings.get('oc_group')!;
  bindings.set('oc_group', { ...original, name: '旧绑定名' });
  h.group('AA-实际群名');
  await h.names.stop();
  const service = h.makeService(); await service.load();
  expect((await service.list())[0]).toMatchObject({ name: 'AA-实际群名', updatedAtMs: h.native.updatedAtMs });
  // A transient Feishu failure retains the last confirmed group title.
  vi.mocked(h.channel.rawClient.im.v1.chat.get).mockRejectedValueOnce(new Error('temporary lookup failure'));
  await expect(service.send((await service.list())[0]!.id, 'group-read-failure-01', 'test')).rejects.toMatchObject({ status: 503 });
  expect((await service.list())[0]).toMatchObject({ name: 'AA-实际群名', online: false });
  expect(h.enqueue).not.toHaveBeenCalled();
});

it('serves the exact group avatar PNGs for every tool and rejects unknown assets', async () => {
  const h = await harness();
  for (const tool of ['codex', 'claude', 'zcode', 'kilo', 'dsh']) {
    const response = await h.request('/assets/session-avatars/' + tool + '.png');
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(new URL('../../../assets/session-avatars/' + tool + '.png', import.meta.url)));
  }
  expect((await h.request('/assets/session-avatars/unknown.png')).status).toBe(404);
  expect((await h.request('/assets/session-avatars/constructor.png')).status).toBe(404);
});

it('reports native update time and recent bridge input without catalog scan time reordering old sessions', async () => {
  const h = await harness(); await h.names.stop();
  expect((await h.service.list())[0]?.updatedAtMs).toBe(2);
  const original = h.catalog.entries()[0]!;
  h.catalog.upsertActive({ ...original, now: Date.now() + 1000 });
  expect((await h.service.list())[0]?.updatedAtMs).toBe(2);
  h.native.updatedAtMs = 42;
  const refreshed = h.makeService(); await refreshed.load();
  expect((await refreshed.list())[0]?.updatedAtMs).toBe(42);
  const inputTime = Date.now() + 2000;
  await h.inbox.receive('oc_group', { messageId: 'om_pending_recent', chatId: 'oc_group', chatType: 'group', senderId: 'ou_owner', createTime: inputTime,
    content: 'pending', resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: 'text' });
  expect((await refreshed.list())[0]?.updatedAtMs).toBe(inputTime);
  const restarted = h.makeService(); await restarted.load();
  expect((await restarted.list())[0]?.updatedAtMs).toBe(inputTime);
});

it('returns phase/count summaries for native and bridge turns without private details, including a late native snapshot', async () => {
  const h = await harness();
  const id = (await h.service.list())[0]!.id;
  let state = reduce(initialState, { type: 'thinking', delta: 'private-thought' });
  state = reduce(state, { type: 'tool_use', id: 'private-tool-id', name: 'PrivateTool', input: { command: 'private-command' } });
  h.conversation.turns[0]!.state = state;
  const native = await h.service.read(id);
  expect(native.turns[0]?.progress).toEqual(['🧠 思考完成', '🧰 1 个工具调用（进行中）']);
  for (const detail of ['private-thought', 'PrivateTool', 'private-command', 'private-tool-id']) expect(JSON.stringify(native)).not.toContain(detail);
  await h.service.send(id, 'progress-summary-web-01', 'public input');
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  const job = (await h.client.list())[0]!;
  const bridgeTurn = { ...h.conversation.turns[0]!, id: 'bridge-native', bridge: true, bridgeJobId: job.id, createdAtMs: job.createdAt };
  h.conversation.turns.push(bridgeTurn);
  expect((await h.service.read(id)).turns.find(t => t.id === 'job:' + job.id)?.progress).toEqual(['🧠 思考完成', '🧰 1 个工具调用（进行中）']);
  h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
  const finished = await h.service.read(id);
  expect(finished.turns.find(t => t.id === 'job:' + job.id)?.progress).toEqual(['🧠 思考完成', '🧰 1 个工具调用（已完成）']);
  for (const detail of ['private-thought', 'PrivateTool', 'private-command', 'private-tool-id']) expect(JSON.stringify(finished)).not.toContain(detail);
});

it.each([{ code: 232017, data: { name: '错误返回名', chat_mode: 'group' } }, { code: 0, data: { name: '未确认群模式' } }])('keeps the confirmed title and disables writes on an invalid group response: %j', async response => {
  const h = await harness(); await h.names.stop();
  const id = (await h.service.list())[0]!.id;
  vi.mocked(h.channel.rawClient.im.v1.chat.get).mockResolvedValueOnce(response as any);
  await expect(h.service.send(id, 'invalid-group-response-01', 'test')).rejects.toMatchObject({ status: 503 });
  expect((await h.service.list())[0]).toMatchObject({ name: 'AA-web', online: false });
  expect(h.enqueue).not.toHaveBeenCalled();
});

it('refreshes a changed group title after 15 seconds and publishes it through SSE', async () => {
  const h = await harness(); await h.names.stop();
  expect((await h.service.list())[0]?.name).toBe('AA-web');
  h.group('AA-群中改名');
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 15_001);
  try {
    expect((await h.service.list())[0]?.name).toBe('AA-群中改名');
    const response = await fetch(h.web.url + '/api/events', { signal: AbortSignal.timeout(5000) });
    const reader = response.body!.getReader(); let text = '';
    try { while (!text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain('AA-群中改名'); expect(text).not.toContain('"name":"AA-web"');
    } finally { await reader.cancel(); }
  } finally { clock.mockRestore(); }
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
  const h = await harness('kilo', '127.0.0.2'); expect((await h.request('/api/sessions')).status).toBe(401);
  expect((await h.request('/api/login', { secret: h.secret }, { Origin: 'https://evil.test' })).status).toBe(403);
  expect((await h.request('/api/login', { secret: 'wrong' })).status).toBe(401);
  await h.login(); const text = await (await h.request('/api/sessions')).text(); expect(text).not.toContain('cli_test'); expect(text).not.toContain('token'); expect(text).not.toContain('local-kilo');
  h.controls.botOwnerId = 'ou_other'; expect((await h.request('/api/sessions')).status).toBe(401); h.controls.botOwnerId = 'ou_owner';
  await writeFile(h.configPath, JSON.stringify({ ...JSON.parse(await readFile(h.configPath, 'utf8')), secretHash: '0'.repeat(64) })); expect((await h.request('/api/sessions')).status).toBe(401);
});


it('opens loopback without login, retains same-origin/Host checks and disables HTTP and SSE immediately', async () => {
  const h = await harness();
  expect(await (await h.request('/api/access')).json()).toEqual({ loginRequired: false });
  expect((await h.request('/api/sessions')).status).toBe(200);
  const hostileHost = await new Promise<number>(resolve => httpRequest(h.web.url + '/api/sessions', { headers: { Host: 'evil.test' } }, r => { r.resume(); resolve(r.statusCode!); }).end());
  expect(hostileHost).toBe(403);
  expect((await h.request('/api/sessions', undefined, { Origin: 'https://evil.test' })).status).toBe(403);
  const id = (await h.service.list())[0]!.id;
  expect((await h.request('/api/sessions/' + id + '/control', { action: 'stop' }, { Origin: '' })).status).toBe(403);
  const abort = new AbortController(), response = await fetch(h.web.url + '/api/events', { signal: abort.signal });
  const reader = response.body!.getReader(); let text = '';
  try {
    await vi.waitFor(async () => { text += new TextDecoder().decode((await reader.read()).value); expect(text).toContain('event: snapshot'); });
    const cfg = JSON.parse(await readFile(h.configPath, 'utf8')); await writeFile(h.configPath, JSON.stringify({ ...cfg, enabled: false }));
    expect((await h.request('/api/sessions')).status).toBe(401);
    await vi.waitFor(async () => { text += new TextDecoder().decode((await reader.read()).value); expect(text).toContain('event: auth'); });
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

it('shares multiple listeners, trusts real source addresses rather than forwarding headers, and revokes HTTP/SSE on trust changes', async () => {
  const h = await harness('kilo', '127.0.0.2', { additionalHosts: ['127.0.0.3'], trustedNetworks: ['127.0.0.3/32'] });
  const other = h.web.urls[1]!;
  const direct = (url: string, source: string, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    httpRequest(url, { localAddress: source, headers }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
    }).on('error', reject).end();
  });
  for (const url of [h.web.url, other]) {
    expect(await direct(url + '/api/access', '127.0.0.3')).toEqual({ status: 200, json: { loginRequired: false } });
    expect((await direct(url + '/api/sessions', '127.0.0.3')).status).toBe(200);
    expect((await direct(url + '/api/sessions', '127.0.0.1', { 'X-Forwarded-For': '127.0.0.3', 'X-Real-IP': '127.0.0.3' })).status).toBe(401);
    expect((await direct(url + '/api/sessions', '127.0.0.3', { Host: 'evil.test' })).status).toBe(403);
    expect((await direct(url + '/api/sessions', '127.0.0.3', { Origin: 'http://evil.test' })).status).toBe(403);
  }
  await h.login(); expect((await h.request('/api/sessions')).status).toBe(200);
  const events: string[] = [];
  const stream = httpRequest(other + '/api/events', { localAddress: '127.0.0.3' }, res => res.on('data', chunk => events.push(String(chunk))));
  stream.end();
  try {
    await vi.waitFor(() => expect(events.join('')).toContain('event: snapshot'));
    const cfg = JSON.parse(await readFile(h.configPath, 'utf8')); await writeFile(h.configPath, JSON.stringify({ ...cfg, trustedNetworks: [] }));
    expect((await direct(other + '/api/sessions', '127.0.0.3')).status).toBe(401);
    await vi.waitFor(() => expect(events.join('')).toContain('event: auth'));
  } finally { stream.destroy(); }
});

it('closes previously opened listeners when a later listener cannot bind', async () => {
  const h = await harness('kilo', '127.0.0.2');
  const cfg: WebConfig = { ...JSON.parse(await readFile(h.configPath, 'utf8')), host: '127.0.0.3', additionalHosts: ['127.0.0.2'] };
  await expect(startBridgeWeb({ configPath: h.configPath, service: h.service, config: cfg })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  const socket = createServer();
  try { await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(cfg.port, cfg.host, resolve); }); }
  finally { await new Promise<void>(resolve => socket.close(() => resolve())); }
});

function flatten(elements: WebControlElement[]): WebControlElement[] { return elements.flatMap(e => e.kind === 'section' ? flatten(e.elements) : [e]); }

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('runs Web controls through existing %s handlers: stop, settings save/preview, refresh, copy menu and confirmed archive', async tool => {
  const h = await harness(tool), id = (await h.service.list())[0]!.id;
  const act = async (action: string, values?: Record<string, string>) => { const r = await h.request('/api/sessions/' + id + '/control', { action, values }); expect(r.status).toBe(200); return r.json() as Promise<{ elements: WebControlElement[]; conversation: { session: { id: string } } }>; };
  await h.service.send(id, 'control-stop-request-01', 'work'); await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await h.replies.runNow(); await act('stop'); await vi.waitFor(() => expect(h.stop).toHaveBeenCalledOnce());
  const refreshed = await act('refresh'); expect(refreshed.conversation.session.id).toBe(id);
  h.provider.conversation.mockRejectedValueOnce(new Error('temporary native read failure'));
  expect((await act('refresh')).conversation).toMatchObject({ turns: (refreshed.conversation as any).turns, notice: '会话读取失败，稍后自动重试' });
  const settings = flatten((await act('config')).elements);
  const form = Object.fromEntries(settings.flatMap(e => e.kind === 'select' || e.kind === 'input' ? [[e.name, e.value]] : []));
  const preview = settings.find(e => e.kind === 'button' && e.text.includes('推理档位'))!;
  expect(preview.kind).toBe('button'); if (preview.kind !== 'button') throw Error('preview');
  expect(flatten((await act(preview.action, form)).elements).some(e => e.kind === 'select' && e.name === 'reasoning_effort')).toBe(true);
  const save = settings.find(e => e.kind === 'button' && e.text === '保存')!; if (save.kind !== 'button') throw Error('save');
  const result = await act(save.action, { ...form, max_concurrent_runs: '7' });
  expect(JSON.stringify(result)).toContain('偏好已保存'); expect(h.bindings.get('oc_group')?.model).toBe('default');
  expect(JSON.parse(await readFile(h.controls.configPath, 'utf8')).profiles.test.preferences.maxConcurrentRuns).toBe(7);
  expect(await act(save.action, { ...form, max_concurrent_runs: '7' })).toEqual(result);
  expect((await h.request('/api/sessions/' + id + '/control', { action: save.action, values: { ...form, model: 'injected-model' } })).status).toBe(400);
  const copy = flatten((await act('fork')).elements); expect(copy.some(e => e.kind === 'button')).toBe(true);
  const expired = copy.find(e => e.kind === 'button')!;
  if (expired.kind !== 'button') throw Error('copy');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
  try { await expect(h.webControls.execute(id, 'oc_group', 'ou_owner', expired.action)).rejects.toMatchObject({ status: 409 }); } finally { clock.mockRestore(); }
  expect(h.provider.archive).not.toHaveBeenCalled();
  const confirmation = flatten((await act('finish')).elements); expect(h.provider.archive).not.toHaveBeenCalled();
  const archive = confirmation.find(e => e.kind === 'button' && e.text === '归档')!; if (archive.kind !== 'button') throw Error('archive');
  expect(archive).toMatchObject({ danger: true, primary: false });
  expect(confirmation.find(e => e.kind === 'button' && e.text === '归档并解散群')).toMatchObject({ danger: true, primary: false });
  expect((await h.request('/api/sessions/' + id + '/control', { action: 'finish.archive' })).status).toBe(409);
  expect((await h.request('/api/sessions/' + id + '/control', { action: 'finish.archive-dissolve' })).status).toBe(409);
  expect((await h.request('/api/sessions/' + id + '/control', { action: 'exit' })).status).toBe(409);
  expect((await h.request('/api/sessions/' + '0'.repeat(64) + '/control', { action: archive.action })).status).toBe(404);
  h.controls.botOwnerId = 'ou_other'; expect((await h.request('/api/sessions/' + id + '/control', { action: archive.action })).status).toBe(409); h.controls.botOwnerId = 'ou_owner';
  await act(archive.action); expect(h.provider.archive).toHaveBeenCalledOnce(); expect(await h.service.list()).toHaveLength(0);
  expect(h.send).not.toHaveBeenCalled();
});


it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('archives and dissolves a Web-confirmed %s group through the common worker interface', async tool => {
  const h = await harness(tool), id = (await h.service.list())[0]!.id;
  h.workspaces.setCwd('oc_group', h.dir);
  vi.mocked(h.channel.rawClient.im.v1.chat.delete).mockImplementation(async () => {
    expect(h.provider.archive).toHaveBeenCalledOnce(); expect(h.catalog.isScopeArchived('oc_group')).toBe(true);
    return { code: 0 };
  });
  const elements = flatten((await h.service.control(id, 'finish')).elements);
  const button = elements.find(e => e.kind === 'button' && e.text === '归档并解散群');
  if (button?.kind !== 'button') throw Error('missing dissolve choice');
  expect(button).toMatchObject({ danger: true, primary: false });
  const result = await h.service.control(id, button.action);
  expect(JSON.stringify(result)).toContain('会话已归档并解散群');
  expect(h.channel.rawClient.im.v1.chat.delete).toHaveBeenCalledOnce(); expect(h.bindings.get('oc_group')).toBeUndefined();
  expect(h.workspaces.cwdFor('oc_group')).toBeUndefined(); expect(h.catalog.isChatDissolved('oc_group')).toBe(true);
  expect(h.catalog.isAutoGroupSuppressed(tool, h.client.sourceId, 'native')).toBe(true);
  expect(await h.service.list()).toEqual([]); expect(h.send).not.toHaveBeenCalled();
  expect(await h.webControls.execute(id, 'oc_group', 'ou_owner', button.action)).toEqual(result);
  expect(h.channel.rawClient.im.v1.chat.delete).toHaveBeenCalledOnce();
});

it('copies through the native worker, binds one new group, preserves its real managed card and mute context, and does not fork twice on retry', async () => {
  const h = await harness('codex'), id = (await h.service.list())[0]!.id;
  h.native.cwd = h.dir; h.workspaces.setCwd('oc_group', h.dir);
  const chatCreate = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_copy' } }));
  h.channel.rawClient.im.v1.chat.create = chatCreate as any;
  const notifications = vi.fn(async (args: string[]) => args[0] === 'auth' ? { appId: 'cli_test', identities: { user: { available: true, openId: 'ou_owner' } } } : { ok: true, identity: 'user', data: { invalid_ids: [] } });
  configureGroupNotifications(h.channel, { appId: 'cli_test', ownerId: () => 'ou_owner' }, notifications);
  const menu = flatten((await h.service.control(id, 'fork')).elements);
  const fork = menu.find(e => e.kind === 'button' && e.text === 'Codex')!; if (fork.kind !== 'button') throw Error('copy');
  const result = await h.service.control(id, fork.action);
  expect(JSON.stringify(result)).toContain('已创建分叉工作群'); expect(h.provider.fork).toHaveBeenCalledOnce(); expect(chatCreate).toHaveBeenCalledOnce();
  expect(h.bindings.get('oc_copy')).toMatchObject({ nativeId: 'native-fork', toolId: 'codex' }); expect(h.bindings.get('oc_group')?.nativeId).toBe('native');
  expect(notifications).toHaveBeenCalledTimes(2);
  expect(h.send).toHaveBeenCalledWith('oc_copy', { cardId: 'card' }, undefined);
  expect(await h.service.control(id, fork.action)).toEqual(result); expect(h.provider.fork).toHaveBeenCalledOnce(); expect(chatCreate).toHaveBeenCalledOnce();
});

it('persists favorites across restarts and scopes them to the owner and stable binding identity', async () => {
  const h = await harness(), row = (await h.service.list())[0]!;
  expect(row.favorite).toBe(false);
  const response = await h.request('/api/sessions/' + row.id + '/favorite', { favorite: true });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ favorite: true });
  const restarted = h.makeService(); await restarted.load(); expect((await restarted.list())[0]!.favorite).toBe(true);
  h.controls.botOwnerId = 'ou_other'; expect((await restarted.list())[0]!.favorite).toBe(false);
  await restarted.favorite(row.id, true); await restarted.favorite(row.id, false);
  h.controls.botOwnerId = 'ou_owner'; expect((await restarted.list())[0]!.favorite).toBe(true);
  expect((await h.request('/api/sessions/' + row.id + '/favorite', { favorite: 'yes' })).status).toBe(400);
  expect((await h.request('/api/sessions/' + '0'.repeat(64) + '/favorite', { favorite: true })).status).toBe(404);
  h.bindings.set('oc_group', { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'replacement' });
  expect((await restarted.list())[0]!.favorite).toBe(false);
  await expect(restarted.favorite(row.id, true)).rejects.toMatchObject({ status: 404 });
  expect(h.create).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
});
it('allows favoriting an offline binding without submitting work', async () => {
  const h = await harness(); await h.service.list();
  vi.spyOn(h.client, 'health').mockRejectedValue(Error('offline'));
  const offline = h.makeService(); await offline.load(); const row = (await offline.list())[0]!;
  expect(row.online).toBe(false); await offline.favorite(row.id, true);
  expect((await offline.list())[0]!.favorite).toBe(true); expect(h.create).not.toHaveBeenCalled();
});
it('hides bindings excluded by an authoritative worker roster and skips their native synchronization without archiving', async () => {
  const h = await harness('kilo', '127.0.0.1', {}, true); h.provider.list.mockResolvedValue([]);
  const service = h.makeService(); await service.load();
  expect(await service.list()).toEqual([]); expect(await h.client.sessionAvailable('native')).toBe(false);
  const read = vi.fn();
  const sync = await startNativeTurnSync({ toolId: 'kilo', displayName: 'Generic', channel: h.channel, controls: h.controls,
    catalog: h.catalog, sourceId: h.client.sourceId, statePath: join(h.dir, 'excluded-sync.json'), intervalMs: 60_000,
    available: id => h.client.sessionAvailable(id), reader: { read, close: async () => {} } });
  try { expect(read).not.toHaveBeenCalled(); expect(h.bindings.get('oc_group')).toBeDefined(); expect(h.catalog.isScopeArchived('oc_group')).toBe(false); } finally { await sync.stop(); }
  const failed = vi.spyOn(h.client, 'health').mockRejectedValue(Error('offline'));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
  try { expect(await service.list()).toEqual([]); } finally { failed.mockRestore(); clock.mockRestore(); }
});

it('publishes favorite changes to other Web clients via SSE without submitting a message', async () => {
  const h = await harness(), id = (await h.service.list())[0]!.id;
  const response = await fetch(h.web.url + '/api/events', { signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader(); let text = '';
  try {
    while (!text.includes('"favorite":false')) text += new TextDecoder().decode((await reader.read()).value);
    expect((await h.request('/api/sessions/' + id + '/favorite', { favorite: true })).status).toBe(200);
    while (!text.includes('"favorite":true')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"favorite":true'); expect(h.enqueue).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  } finally { await reader.cancel(); }
});
