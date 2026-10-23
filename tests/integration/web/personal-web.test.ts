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
import { PersonalSessionService, type WebConversation } from '../../../src/web/service';
import { cleanDissolvedChat } from '../../../src/bot/group-cleanup';
import { BridgeConsoleService } from '../../../src/web/console';
import { AuxiliaryGroups } from '../../../src/bot/auxiliary-groups';
import { startBridgeWeb } from '../../../src/web/server';
import { configureWeb, webPasswordHash } from '../../../src/web/config';
import { WebSessionControls, type WebControlElement, type WebControlResult } from '../../../src/web/controls';
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
    history: async () => undefined, rename: vi.fn(async (id: string, name: string) => { const session = [native, ...copies].find(row => row.nativeId === id); if (!session) throw Error('missing session'); session.name = name; }), archive: vi.fn(async () => { native.archived = true; }),
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
  const create = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: 'om_web' } }));
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
    control: (id, scope, owner, action, values) => webControls.execute(id, scope, owner, action, values) });
  const service = makeService(); await service.load();
  const socket = createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r)); const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()));
  const configPath = join(h.dir, 'web.json'), { secret } = await configureWeb(configPath, '127.0.0.1', port);
  if (host !== '127.0.0.1' || Object.keys(access).length) await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), host, ...access }));
  const consoleService = new BridgeConsoleService({ controls, catalog, channel, personal: service, syncNames: async () => { await names.tick(); }, cleanDissolvedGroup: chatId => cleanDissolvedChat({ channel, controls, catalog, sessions, workspaces, cancelPending: scope => inbox.rejectChat(scope).then(() => {}) }, chatId) });
  const web = (await startBridgeWeb({ configPath, service, consoleService, pollMs: 30 }))!; cleanups.push(() => web.close());
  let cookie = '';
  const request = (path: string, value?: unknown, headers = {}) => fetch(web.url + path, { method: value === undefined ? 'GET' : 'POST', headers: {
    Cookie: cookie, Origin: web.url, 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const login = async () => { const response = await request('/api/login', { secret }); expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''; };
  const replies = await startWorkerReplies({ adapter: h.adapter, channel, controls, catalog, sessions, activeRuns, statePath: join(h.dir, 'replies.json'), intervalMs: 60_000 }); cleanups.push(() => replies.stop());
  controls.workerRuntimes!.get(tool)!.replies = replies;
  return { ...h, bindings, catalog, controls, sessions, inbox, service, consoleService, makeService, request, login, web, secret, configPath, webControls, workspaces, send, channel, create, enqueue, names, native, conversation, provider, replies, activeRuns, group: (name: string) => { group = name; } };
}

async function sharedInput(h: Awaited<ReturnType<typeof harness>>, options: { name?: string; content?: string } = {}) {
  const toolId = h.bindings.get('oc_group')!.toolId;
  const source = { toolId, sourceId: h.client.sourceId, nativeId: 'native' };
  h.bindings.set('aux_shared', { ...source, linkedSource: source, nativeCreated: true });
  h.bindings.linkAuxiliary('oc_shared', 'aux_shared');
  const group = { chatId: 'oc_shared', name: '共享群', ownerId: 'ou_owner', source: structuredClone(source) };
  const auxiliary = { isAuxiliary: (scope: string): boolean => scope === 'oc_shared', isActive: (scope: string): boolean => scope === 'oc_shared',
    get: (scope: string) => scope === 'oc_shared' ? group : undefined, trackRun: vi.fn(async () => {}) };
  h.controls.auxiliary = auxiliary as any;
  const get = vi.fn(async () => ({ code: 0, data: { items: [{ message_id: 'om_shared', sender: { id: 'ou_nick', sender_name: 'Nick Yang' } }] } }));
  (h.channel.rawClient.im.v1.message as any).get = get;
  const message: NormalizedMessage = { messageId: 'om_shared', chatId: 'oc_shared', chatType: 'group', senderId: 'ou_nick', senderName: options.name,
    content: options.content ?? '共享群成员的问题', createTime: Date.now(), resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: 'text' };
  await h.inbox.receive('oc_shared', message);
  const job = await h.client.submit({ requestKey: 'shared-message-one', options: { ...h.options, prompt: 'PRIVATE-POLICY\n' + message.content,
    delivery: { ...h.options.delivery!, scope: 'oc_shared', chatId: 'oc_shared', replyTo: message.messageId, messageIds: [message.messageId], operatorOpenId: message.senderId } } });
  await vi.waitFor(async () => expect((await h.client.snapshot(job.id)).events.length).toBeGreaterThan(1));
  await h.inbox.reconcile(await h.client.list());
  return { job, message, group, auxiliary, get };
}

async function managedShared(h: Awaited<ReturnType<typeof harness>>) {
  h.native.cwd = h.dir;
  (h.channel.rawClient.im.v1 as any).chatMembers = { delete: vi.fn(async () => ({ code: 0 })) };
  const groups = new AuxiliaryGroups({ path: join(h.dir, 'managed-groups.json'), appId: 'cli_test', channel: h.channel,
    tools: h.controls.toolRegistry!, bindings: h.bindings, catalog: h.catalog, sessions: h.sessions, workspaces: h.workspaces,
    ownerId: () => h.controls.botOwnerId, refreshOwner: async () => {}, cancelPending: async scope => { await h.inbox.rejectScope(scope); } });
  await groups.load(); h.controls.auxiliary = groups;
  cleanups.push(() => groups.flush());
  await groups.joined({ chatId: 'oc_shared', operator: { openId: 'ou_owner' } });
  return groups;
}

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('shows shared %s inputs and Feishu names in the personal group and Web even when native history omits them', async tool => {
  const h = await harness(tool), shared = await sharedInput(h);
  const id = (await h.service.list())[0]!.id;
  expect((await h.service.list())[0]!.updatedAtMs).toBe(shared.message.createTime);
  await h.replies.runNow();
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.create.mock.calls[0]![0]).toMatchObject({ data: { receive_id: 'oc_group', msg_type: 'text' } });
  expect(JSON.parse((h.create.mock.calls[0]![0] as any).data.content).text).toBe('来自共享群\nNick Yang：\n共享群成员的问题');
  const reply = vi.mocked(h.channel.rawClient.im.v1.message.reply);
  expect(reply.mock.calls.filter(([r]) => r?.data.msg_type === 'interactive').map(([r]) => r?.path.message_id).sort()).toEqual(['om_shared', 'om_web']);
  const running = (await h.service.read(id)).turns.find(t => t.id === 'job:' + shared.job.id)!;
  expect(running).toMatchObject({ input: shared.message.content, inputMessages: [{ senderName: 'Nick Yang', text: shared.message.content }], answer: 'before restart\n', status: 'running' });
  expect(JSON.stringify(running)).not.toContain('PRIVATE-POLICY');
  expect(h.inbox.receipts('oc_shared')[0]!.message.senderName).toBe('Nick Yang');
  // A late, incomplete native projection must not duplicate or replace the journal answer.
  h.conversation.turns.push({ id: 'native-shared-turn', bridge: true, bridgeJobId: shared.job.id, input: '', createdAtMs: shared.job.createdAt,
    state: { ...initialState, blocks: [], terminal: 'running' } } as any);
  h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
  await h.replies.runNow(); await h.replies.runNow();
  const completed = await h.service.read(id);
  expect(completed.turns.filter(t => t.id === 'job:' + shared.job.id || t.id === 'native:native-shared-turn')).toHaveLength(1);
  expect(completed.turns.find(t => t.id === 'job:' + shared.job.id)).toMatchObject({ answer: 'before restart\nafter restart', status: 'completed', inputMessages: running.inputMessages });
  const mirror = await startNativeTurnSync({ toolId: tool, displayName: 'Generic worker', channel: h.channel, controls: h.controls, catalog: h.catalog,
    sourceId: h.client.sourceId, statePath: join(h.dir, 'native-mirror.json'), intervalMs: 60_000, reader: { read: sid => h.client.conversation(sid), close: async () => {} } });
  await mirror.runNow(); await mirror.stop();
  await h.replies.stop();
  const count = reply.mock.calls.length;
  const restarted = await startWorkerReplies({ adapter: h.adapter, channel: h.channel, controls: h.controls, catalog: h.catalog, sessions: h.sessions,
    activeRuns: h.activeRuns, statePath: join(h.dir, 'replies.json'), intervalMs: 60_000 });
  try { await restarted.runNow(); expect(h.create).toHaveBeenCalledOnce(); expect(reply).toHaveBeenCalledTimes(count); }
  finally { await restarted.stop(); }
  expect(shared.get).toHaveBeenCalledOnce(); expect(h.calls).toHaveLength(1);
});

it('repairs recent completed shared deliveries independently of the already-finished source without historical mentions', async () => {
  const h = await harness('codex'); await h.replies.stop();
  const shared = await sharedInput(h); h.finish();
  await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
  const path = join(h.dir, 'replies.json'), ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.deliveries[shared.job.id] = { mode: 'card', finished: true, controlsVersion: 1, sequence: 1, lastEvent: 99, pushedAt: 1 };
  await writeFile(path, JSON.stringify(ledger));
  const replies = await startWorkerReplies({ adapter: h.adapter, channel: h.channel, controls: h.controls, catalog: h.catalog, sessions: h.sessions,
    activeRuns: h.activeRuns, statePath: path, intervalMs: 60_000 });
  try {
    await replies.runNow(); await replies.runNow(); expect(h.create).toHaveBeenCalledOnce();
    const reply = vi.mocked(h.channel.rawClient.im.v1.message.reply);
    expect(reply).toHaveBeenCalledOnce(); expect(reply.mock.calls[0]![0]?.data.msg_type).toBe('interactive');
    expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls)).toContain('after restart');
  } finally { await replies.stop(); }
});

it('uses the requesting member name rather than the bot-card sender and follows member pagination', async () => {
  const h = await harness('codex'), shared = await sharedInput(h);
  shared.get.mockResolvedValue({ code: 0, data: { items: [{ message_id: 'om_shared', sender: { id: 'cli_bot', sender_name: 'Bot' } }] } });
  const members = vi.fn(async (request: any) => ({ code: 0, data: request.params.page_token ?
    { items: [{ member_id: 'ou_nick', name: 'Nick Yang' }], has_more: false } : { items: [{ member_id: 'ou_owner', name: 'Owner' }], has_more: true, page_token: 'page2' } }));
  (h.channel.rawClient.im.v1 as any).chatMembers = { get: members };
  const turn = (await h.service.read((await h.service.list())[0]!.id)).turns.find(t => t.id === 'job:' + shared.job.id)!;
  expect(turn.inputMessages).toEqual([{ senderName: 'Nick Yang', text: shared.message.content }]);
  await h.replies.runNow(); expect(members).toHaveBeenCalledTimes(2); expect(shared.get).toHaveBeenCalledOnce();
  expect(JSON.stringify(h.create.mock.calls)).toContain('Nick Yang'); expect(JSON.stringify(h.create.mock.calls)).not.toContain('Bot');
});

it('keeps the original shared input visible during name lookup outages and preserves each batched sender', async () => {
  const h = await harness('kilo'), shared = await sharedInput(h);
  shared.get.mockRejectedValue(new Error('lookup unavailable'));
  h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
  const first = { ...shared.message, messageId: 'om_shared_batch_first' };
  const second = { ...shared.message, messageId: 'om_shared_second', senderId: 'ou_other', senderName: '另一位成员', content: '第二条消息' };
  await h.inbox.receive('oc_shared', first);
  await h.inbox.receive('oc_shared', second);
  const job = await h.client.submit({ requestKey: 'shared-batch', options: { ...h.options, prompt: 'PRIVATE-POLICY',
    delivery: { ...shared.job.options.delivery!, messageIds: [first.messageId, second.messageId] } } });
  await vi.waitFor(async () => expect((await h.client.snapshot(job.id)).events.length).toBeGreaterThan(1));
  const turn = (await h.service.read((await h.service.list())[0]!.id)).turns.find(t => t.id === 'job:' + job.id)!;
  expect(turn.inputMessages).toEqual([{ senderName: 'ou_nick', text: shared.message.content }, { senderName: '另一位成员', text: second.content }]);
  expect(turn.input).toBe(shared.message.content + '\n\n' + second.content);
  expect(JSON.stringify(turn)).not.toContain('PRIVATE-POLICY');
});

it('keeps the persisted repair cutoff after restart and avoids forwarding old completed shared history', async () => {
  const h = await harness('codex'); await h.replies.stop(); const shared = await sharedInput(h); h.finish();
  await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
  const path = join(h.dir, 'replies.json'), ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.sharedMirrorSince = shared.job.createdAt + 1; await writeFile(path, JSON.stringify(ledger));
  const replies = await startWorkerReplies({ adapter: h.adapter, channel: h.channel, controls: h.controls, catalog: h.catalog, sessions: h.sessions,
    activeRuns: h.activeRuns, statePath: path, intervalMs: 60_000 });
  try { await replies.runNow(); expect(h.create).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(path, 'utf8')).sharedMirrorSince).toBe(ledger.sharedMirrorSince); }
  finally { await replies.stop(); }
  expect((await h.service.read((await h.service.list())[0]!.id)).turns.find(t => t.id === 'job:' + shared.job.id)?.inputMessages?.[0]?.senderName).toBe('Nick Yang');
});

it('retries a lost personal input acknowledgement with the same UUID and stops the shared worker from the personal group', async () => {
  const h = await harness('kilo'); await sharedInput(h);
  h.create.mockRejectedValueOnce(new Error('ack lost'));
  await h.replies.runNow(); expect(h.create).toHaveBeenCalledOnce();
  await h.replies.runNow(); expect(h.create).toHaveBeenCalledTimes(2);
  expect((h.create.mock.calls[0]![0] as any).data.uuid).toBe((h.create.mock.calls[1]![0] as any).data.uuid);
  expect(await h.replies.stopScope('oc_group')).toBe(true);
  await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('interrupted'));
  await h.replies.runNow(); expect(h.stop).toHaveBeenCalledOnce(); expect(h.create).toHaveBeenCalledTimes(2);
});

it.each(['private', 'inactive', 'owner', 'rebound', 'source', 'archived', 'legacy', 'receipt'] as const)('keeps unrelated/shared %s audiences out of personal history and forwarding', async change => {
  const h = await harness('codex'), shared = await sharedInput(h), id = (await h.service.list())[0]!.id;
  if (change === 'private') (shared.group as any).privateGroup = { actorId: 'ou_nick' };
  if (change === 'inactive') shared.auxiliary.isActive = () => false;
  if (change === 'owner') shared.group.ownerId = 'ou_another';
  if (change === 'rebound') h.bindings.set('oc_group', { ...h.bindings.get('oc_group')!, nativeId: 'different-native' });
  if (change === 'source') shared.group.source.sourceId = 'another-worker';
  if (change === 'archived') h.catalog.archiveScope('oc_shared', 'native');
  if (change === 'legacy') h.bindings.set('oc_group', { ...h.bindings.get('oc_group')!, auxiliaryWorkgroup: true });
  if (change === 'receipt') h.controls.workerRuntimes!.get('codex')!.inbox = new WorkerInbox(join(h.dir, 'empty-inbox.json'));
  await h.replies.runNow(); expect(h.create).not.toHaveBeenCalled();
  if (change === 'rebound' || change === 'legacy') await expect(h.service.read(id)).rejects.toMatchObject({ status: 404 });
  else expect((await h.service.read(id)).turns.some(t => t.input === shared.message.content)).toBe(false);
});

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
  state = reduce(state, { type: 'text', delta: 'public progress' });
  state = reduce(state, { type: 'tool_use', id: 'private-tool-id', name: 'PrivateTool', input: { command: 'private-command' } });
  state = reduce(state, { type: 'text', delta: '**public answer**' });
  h.conversation.turns[0]!.state = state;
  const native = await h.service.read(id);
  expect(native.turns[0]?.progress).toEqual(['🧠 思考完成', '🧰 1 个工具调用（进行中）']);
  expect(native.turns[0]?.answerSections).toHaveLength(2);
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
  expect(finished.turns.find(t => t.id === 'job:' + job.id)?.answerSections).toEqual(native.turns[0]?.answerSections);
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
  expect(h.native.name).toBe('AA-Web改名');
  await h.names.tick(); await h.names.tick(); expect(h.native.name).toBe('AA-Web改名'); expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-Web改名' });
  h.group('AA-群改名'); await h.names.tick(); expect(h.native.name).toBe('AA-群改名');
  await h.names.tick(); h.native.name = 'AA-工具改名'; await h.names.tick(); expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-工具改名' });
  expect((await h.service.list())[0]?.name).toBe('AA-工具改名');
});

it('accepts a Web rename while the worker is executing and syncs the native title after completion', async () => {
  const h = await harness('kilo'), id = (await h.service.list())[0]!.id;
  const nativeRename = vi.spyOn(h.provider, 'rename');
  const attempts = vi.spyOn(h.controls.toolRegistry!.get('kilo').sessions!, 'rename');
  const job = await h.client.submit({ requestKey: 'rename-while-running', options: { ...h.options, sessionId: 'native', initialSessionId: undefined } });
  await vi.waitFor(async () => expect((await h.client.list()).find(j => j.id === job.id)?.status).toBe('running'));
  const response = await h.request('/api/sessions/' + id + '/rename', { name: 'AA-Web忙时改名' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: 'AA-Web忙时改名' });
  expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-Web忙时改名' });
  expect((await h.service.list())[0]?.name).toBe('AA-Web忙时改名');
  expect(h.native.name).toBe('AA-web');
  expect(nativeRename).not.toHaveBeenCalled();
  expect(attempts).toHaveBeenCalledOnce();
  expect(attempts).toHaveBeenCalledWith('native', 'AA-Web忙时改名');
  h.finish(); await vi.waitFor(async () => expect((await h.client.list()).find(j => j.id === job.id)?.status).toBe('completed'));
  await h.names.tick(); expect(h.native.name).toBe('AA-Web忙时改名');
  expect((await h.client.list())).toHaveLength(1);
});

it('renames the group even when its worker is offline', async () => {
  const h = await harness('kilo'), id = (await h.service.list())[0]!.id;
  const nativeRename = vi.spyOn(h.provider, 'rename').mockRejectedValue(Error('native unavailable'));
  h.provider.list.mockClear();
  h.controls.toolRegistry!.remove('kilo');
  expect((await h.service.list())[0]).toMatchObject({ online: false, canRename: true });
  const response = await h.request('/api/sessions/' + id + '/rename', { name: 'AA-离线时群改名' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: 'AA-离线时群改名' });
  expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-离线时群改名' });
  expect((await h.service.list())[0]?.name).toBe('AA-离线时群改名');
  expect(nativeRename).not.toHaveBeenCalled();
  expect(h.provider.list).not.toHaveBeenCalled();
});

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('ignores a failed Web %s native rename and leaves its normal sync poll to finish it', async tool => {
  const h = await harness(tool), id = (await h.service.list())[0]!.id;
  const nativeRename = h.provider.rename.mockRejectedValueOnce(Error('native unavailable'));
  const attempts = vi.spyOn(h.controls.toolRegistry!.get(tool).sessions!, 'rename');
  const response = await h.request('/api/sessions/' + id + '/rename', { name: 'AA-Web改名' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: 'AA-Web改名' });
  expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-Web改名' });
  expect(h.native.name).toBe('AA-web');
  expect(nativeRename).toHaveBeenCalledOnce();
  expect(attempts).toHaveBeenCalledOnce();
  await h.names.tick();
  expect(h.native.name).toBe('AA-Web改名');
  expect(attempts).toHaveBeenCalledTimes(2);
  expect(attempts).toHaveBeenNthCalledWith(1, 'native', 'AA-Web改名');
  expect(attempts).toHaveBeenNthCalledWith(2, 'native', 'AA-Web改名');
});

it('reports a rejected group rename without changing the native title or the synchronization baseline', async () => {
  const h = await harness('kilo'), id = (await h.service.list())[0]!.id;
  const nativeRename = vi.spyOn(h.provider, 'rename');
  const ledger = await readFile(join(h.dir, 'kilo-name-sync.json'), 'utf8');
  vi.mocked(h.channel.rawClient.im.v1.chat.update).mockResolvedValueOnce({ code: 232017 });
  const response = await h.request('/api/sessions/' + id + '/rename', { name: 'AA-被拒绝的群名' });
  expect(response.status).toBe(503);
  expect(await h.channel.getChatInfo('oc_group')).toMatchObject({ name: 'AA-web' });
  expect(await readFile(join(h.dir, 'kilo-name-sync.json'), 'utf8')).toBe(ledger);
  expect(nativeRename).not.toHaveBeenCalled();
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

it.each(['0.0.0.0', '::'])('serves all %s interfaces with fixed-password/token auth and revokes HTTP/SSE after credential changes', async host => {
  const h = await harness('kilo', host, { trustedNetworks: ['127.0.0.3/32'] });
  if (host === '::') expect(await (await fetch(h.web.urls.find(url => url.includes('[::1]'))! + '/api/access')).json()).toEqual({ loginRequired: false });
  const password = 'integration-fixed-password';
  const cfg = JSON.parse(await readFile(h.configPath, 'utf8'));
  cfg.passwordHash = await webPasswordHash(password); await writeFile(h.configPath, JSON.stringify(cfg));
  const direct = (path: string, source: string, value?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; cookie?: string; json: any }>((resolve, reject) => {
    const req = httpRequest(h.web.url + path, { localAddress: source, method: value === undefined ? 'GET' : 'POST',
      headers: { Origin: h.web.url, 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], json: JSON.parse(text) }));
    }); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
  for (const source of ['127.0.0.1', '127.0.0.3']) {
    expect((await direct('/api/access', source)).json).toEqual({ loginRequired: false });
    expect((await direct('/api/sessions', source)).status).toBe(200);
  }
  expect((await direct('/api/access', '127.0.0.2')).json).toEqual({ loginRequired: true });
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { 'X-Forwarded-For': '127.0.0.3' })).status).toBe(401);
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { Host: 'evil.test' })).status).toBe(403);
  expect((await direct('/api/login', '127.0.0.2', { secret: 'wrong' })).status).toBe(401);
  const login = await direct('/api/login', '127.0.0.2', { secret: password }); expect(login.status).toBe(200);
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { Cookie: login.cookie! })).status).toBe(200);
  expect((await direct('/api/login', '127.0.0.2', { secret: h.secret })).status).toBe(200);
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { Authorization: `Bearer ${h.secret}` })).status).toBe(200);
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await direct('/api/sessions', '127.0.0.2', undefined, { Authorization: `Bearer ${password}` })).status).toBe(401);
  const events: string[] = [];
  const stream = httpRequest(h.web.url + '/api/events', { localAddress: '127.0.0.2', headers: { Cookie: login.cookie! } }, res => res.on('data', chunk => events.push(String(chunk))));
  stream.end();
  try {
    await vi.waitFor(() => expect(events.join('')).toContain('event: snapshot'));
    cfg.passwordHash = await webPasswordHash('changed-password'); await writeFile(h.configPath, JSON.stringify(cfg));
    expect((await direct('/api/sessions', '127.0.0.2', undefined, { Cookie: login.cookie! })).status).toBe(401);
    await vi.waitFor(() => expect(events.join('')).toContain('event: auth'));
    expect((await direct('/api/login', '127.0.0.2', { secret: password })).status).toBe(401);
    expect((await direct('/api/login', '127.0.0.2', { secret: 'changed-password' })).status).toBe(200);
    cfg.secretHash = '0'.repeat(64); await writeFile(h.configPath, JSON.stringify(cfg));
    expect((await direct('/api/sessions', '127.0.0.2', undefined, { Authorization: `Bearer ${h.secret}` })).status).toBe(401);
    const attempts = await Promise.all(Array.from({ length: 10 }, () => direct('/api/login', '127.0.0.4', { secret: 'wrong' })));
    expect(attempts.filter(row => row.status === 401)).toHaveLength(8);
    expect(attempts.filter(row => row.status === 429)).toHaveLength(2);
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

it('offers the next unused copy name in Web, including unbound and archived native sessions', async () => {
  const h = await harness('kilo');
  h.native.name = 'AA-web-2'; h.group(h.native.name);
  h.bindings.set('oc_group', { ...h.bindings.get('oc_group')!, name: h.native.name });
  h.provider.list.mockResolvedValue([h.native,
    { ...h.native, nativeId: 'unbound-3', name: 'AA-web-3' },
    { ...h.native, nativeId: 'archived-4', name: 'AA-web-4', archived: true },
  ]);
  const id = (await h.service.list())[0]!.id;
  const response = await h.request('/api/sessions/' + id + '/control', { action: 'fork' });
  expect(response.status).toBe(200);
  const menu = flatten(((await response.json()) as WebControlResult).elements);
  expect(menu.find(e => e.kind === 'input')).toMatchObject({ name: 'new_session_name', value: 'AA-web-5' });
  expect(h.provider.fork).not.toHaveBeenCalled();
});

it.each(['codex', 'zcode', 'kilo', 'dsh'] as const)('copies through the %s worker with the chosen name, binds one new group, and does not fork twice on retry', async tool => {
  const h = await harness(tool), id = (await h.service.list())[0]!.id;
  h.native.cwd = h.dir; h.workspaces.setCwd('oc_group', h.dir);
  const chatCreate = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_copy' } }));
  h.channel.rawClient.im.v1.chat.create = chatCreate as any;
  const notifications = vi.fn(async (args: string[]) => args[0] === 'auth' ? { appId: 'cli_test', identities: { user: { available: true, openId: 'ou_owner' } } } : { ok: true, identity: 'user', data: { invalid_ids: [] } });
  configureGroupNotifications(h.channel, { appId: 'cli_test', ownerId: () => 'ou_owner' }, notifications);
  const menu = flatten((await h.service.control(id, 'fork')).elements);
  expect(menu.find(e => e.kind === 'input')).toMatchObject({ name: 'new_session_name', label: '新会话名字', value: 'AA-web-2' });
  const fork = menu.find(e => e.kind === 'button')!; if (fork.kind !== 'button') throw Error('copy');
  const values = { new_session_name: 'AA-web自定义副本' };
  const result = await h.service.control(id, fork.action, values);
  expect(JSON.stringify(result)).toContain('已创建分叉工作群'); expect(h.provider.fork).toHaveBeenCalledOnce(); expect(chatCreate).toHaveBeenCalledOnce();
  expect(h.bindings.get('oc_copy')).toMatchObject({ nativeId: 'native-fork', toolId: tool, name: values.new_session_name });
  expect((await h.client.listSessions()).find(row => row.nativeId === 'native-fork')?.name).toBe(values.new_session_name);
  expect(chatCreate.mock.calls[0]).toMatchObject([{ data: { name: values.new_session_name } }]);
  expect(h.bindings.get('oc_group')).toMatchObject({ nativeId: 'native', name: 'AA-web' }); expect(h.native.name).toBe('AA-web');
  expect(notifications).toHaveBeenCalledTimes(2);
  expect(h.send).toHaveBeenCalledWith('oc_copy', { cardId: 'card' }, undefined);
  expect(await h.service.control(id, fork.action, values)).toEqual(result); expect(h.provider.fork).toHaveBeenCalledOnce(); expect(chatCreate).toHaveBeenCalledOnce();
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


it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('preserves visible %s answer boundaries and Markdown without exposing tool details', async tool => {
  const h = await harness(tool), id = (await h.service.list())[0]!.id;
  const state = { ...initialState, terminal: 'done' as const, footer: null, blocks: [
    { kind: 'text' as const, content: '先检查配置。', streaming: false },
    { kind: 'tool' as const, tool: { id: 'private-id', name: 'private-tool', input: 'private-command', output: 'private-output', status: 'done' as const } },
    { kind: 'text' as const, content: '## 完成\n\n| 项目 | 状态 |\n| -- | -- |\n| 渲染 | **正常** |\n\nhttps://example.com', streaming: false },
  ] };
  h.conversation.turns[0]!.state = state;
  const result = await (await h.request('/api/sessions/' + id)).json() as WebConversation;
  expect(result.turns[0]!.answer).toBe(state.blocks.filter(b => b.kind === 'text').map(b => b.content).join('\n\n'));
  expect(result.turns[0]!.answerSections!).toHaveLength(2);
  expect(result.turns[0]!.answerSections![0]!.nodes[0]!.tag).toBe('p');
  expect(result.turns[0]!.answerSections![1]!.nodes.map(n => n.tag)).toEqual(['h2', 'table', 'p']);
  for (const detail of ['private-id', 'private-tool', 'private-command', 'private-output']) expect(JSON.stringify(result)).not.toContain(detail);
});

it.each(['codex', 'zcode', 'kilo', 'claude', 'dsh'] as const)('console observes %s through common APIs without leaking worker prompts or credentials', async tool => {
  const h = await harness(tool); await h.replies.stop();
  const msg = { messageId: 'console-pending', chatId: 'oc_group', senderId: 'ou_nick', senderName: '<Nick>', content: '待发送的消息', createTime: Date.now(), resources: [] } as unknown as NormalizedMessage;
  await h.inbox.receive('oc_group', msg); h.inbox.defer('oc_group', [msg]);
  await h.inbox.recordDiagnostic('oc_group', [msg], 'archive-check-unavailable', '归档查询超时 Bearer private-console-token', true);
  const response = await h.request('/api/console?refresh=1'); expect(response.status).toBe(200);
  const snapshot = await response.json() as Awaited<ReturnType<BridgeConsoleService['snapshot']>>;
  expect(snapshot.workers[0]).toMatchObject({ id: tool, online: true, capabilities: { conversation: true } });
  expect(snapshot.summary.pending).toBe(1);
  expect(snapshot.bindings[0]).toMatchObject({ kind: '个人 AI 群', groupName: 'AA-web', sessionName: 'AA-web', issues: [] });
  expect(snapshot.items[0]).toMatchObject({ text: msg.content, status: 'pending', sender: '<Nick>', canRetry: true });
  expect(JSON.stringify(snapshot)).not.toContain('private-console-token');
  const page = await h.request('/console'); expect(await page.text()).toContain('AI会话群管理');
  h.controls.ownerRefreshState = 'failed'; expect((await h.request('/api/console')).status).toBe(503);
});

it('console keeps pending retry separate from accepted jobs and reconciles fresh worker receipts before scheduling', async () => {
  const h = await harness(); await h.replies.stop();
  const msg = { messageId: 'console-retry', chatId: 'oc_group', content: '消息', createTime: Date.now(), resources: [] } as unknown as NormalizedMessage;
  await h.inbox.receive('oc_group', msg); h.inbox.defer('oc_group', [msg]);
  const runNow = vi.fn(async () => {}); h.controls.workerRuntimes!.get('kilo')!.replies = { runNow, stopScope: async () => false };
  const before = await h.consoleService.snapshot(true), id = before.items[0]!.id;
  expect((await h.request('/api/console/action', { action: 'retry', id })).status).toBe(200);
  expect(runNow).toHaveBeenCalledOnce(); expect(h.inbox.available()).toHaveLength(1);
  const job = await h.client.submit({ requestKey: 'console-accepted', options: { ...h.options, prompt: 'PRIVATE-POLICY-DO-NOT-DISPLAY',
    delivery: { ...h.options.delivery!, messageIds: [msg.messageId] } } });
  const after = await h.consoleService.snapshot(true);
  expect(after.items.find(i => i.id === id)).toMatchObject({ jobId: job.id, canRetry: false });
  expect(JSON.stringify(after)).not.toContain('PRIVATE-POLICY');
  expect((await h.request('/api/console/action', { action: 'retry', id })).status).toBe(409);
  expect(runNow).toHaveBeenCalledOnce();
  const detail = await (await h.request('/api/console/items/' + id)).json() as Awaited<ReturnType<BridgeConsoleService['detail']>>;
  expect(detail.timeline.some((r: { title: string }) => r.title.includes('持久回执'))).toBe(true);
  expect(JSON.stringify(detail)).not.toContain('PRIVATE-POLICY');
});

it('console reports name mismatches, uses the existing sync path, and removes diagnostic log access', async () => {
  const h = await harness(); await h.replies.stop();
  h.group('网页群改名');
  expect((await h.consoleService.snapshot(true)).bindings[0]!.issues).toContain('群名与会话名不一致');
  expect((await h.request('/api/console/action', { action: 'sync-names' })).status).toBe(200);
  expect(h.native.name).toBe('网页群改名');
  expect((await h.request('/api/console/logs')).status).toBe(404);
  expect(await (await h.request('/console')).text()).not.toContain('诊断日志');
  expect((await h.request('/api/console/action', { action: 'stop' })).status).toBe(400);
});

it('console API shares login, token authentication and cross-site protection with conversations', async () => {
  const h = await harness('kilo', '127.0.0.2', { trustedNetworks: [] });
  expect((await h.request('/api/console')).status).toBe(401);
  expect((await h.request('/api/console/logs')).status).toBe(401);
  expect((await h.request('/api/console', undefined, { Authorization: 'Bearer ' + h.secret })).status).toBe(200);
  await h.login(); expect((await h.request('/api/console')).status).toBe(200);
  expect((await h.request('/api/console/action', { action: 'sync-names' }, { Origin: 'http://evil.test' })).status).toBe(403);
});

it('console marks unreadable native state and disables name sync without treating it as archived', async () => {
  const h = await harness(); await h.replies.stop();
  vi.spyOn(h.client, 'listSessions').mockRejectedValue(Error('native list unavailable'));
  const snapshot = await h.consoleService.snapshot(true), binding = snapshot.bindings[0]!;
  expect(snapshot.workers[0]).toMatchObject({ online: true, error: '会话读取失败：Error: native list unavailable' });
  expect(binding.issues).toContain('原生会话状态未确认'); expect(binding.canSync).toBe(false);
  expect(h.catalog.isScopeArchived('oc_group')).toBe(false);
  expect((await h.request('/api/console/action', { action: 'sync-names', id: binding.id })).status).toBe(409);
});

it('console keeps pending messages visible but forbids retry when worker receipts cannot be read or worker is offline', async () => {
  const h = await harness(); await h.replies.stop();
  const msg = { messageId: 'pending-unconfirmed', chatId: 'oc_group', content: '待发送', createTime: Date.now(), resources: [] } as unknown as NormalizedMessage;
  await h.inbox.receive('oc_group', msg);
  vi.spyOn(h.client, 'list').mockRejectedValue(Error('journal unavailable'));
  let snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.workers[0]!.online).toBe(true);
  expect(snapshot.items[0]).toMatchObject({ status: 'pending', canRetry: false });
  expect((await h.request('/api/console/action', { action: 'retry', id: snapshot.items[0]!.id })).status).toBe(409);
  vi.spyOn(h.client, 'health').mockRejectedValue(Error('worker offline'));
  snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.bindings[0]!.issues).toContain('Worker 离线');
  expect(snapshot.items[0]).toMatchObject({ status: 'pending', canRetry: false });
  expect(h.calls).toHaveLength(0);
});

it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('console manages pending and active %s shared groups through owner selection without creating a native session', async tool => {
  const h = await harness(tool); await h.replies.stop(); const groups = await managedShared(h);
  const before = await h.consoleService.snapshot(true), group = before.sharedGroups[0]!, target = before.sharedTargets[0]!;
  expect(group).toMatchObject({ status: 'pending', canBind: true, canLeave: true, sessionName: '尚未关联', associationId: undefined });
  expect(before.bindings.some(b => b.scope === 'oc_shared')).toBe(false);
  expect((await h.request('/api/console/action', { action: 'shared-bind', id: group.id, target: target.id })).status).toBe(200);
  expect(groups.isActive('oc_shared')).toBe(true); expect(h.bindings.get('oc_shared')?.nativeId).toBe('native');
  expect(h.bindings.get('oc_group')?.nativeId).toBe('native'); expect(h.native.archived).toBe(false); expect(h.calls).toHaveLength(0);
  const after = await h.consoleService.snapshot(true);
  expect(after.sharedGroups[0]).toMatchObject({ status: 'active', targetId: target.id, associationId: target.id, sessionName: 'AA-web', canBind: true });
  expect(after.sharedGroups[0]!.sessionId).toBe((await h.service.list())[0]!.id);
  expect(h.send.mock.calls.filter(([chat, content]: unknown[]) => chat === 'oc_shared' && JSON.stringify(content).includes('会话共享已启用'))).toHaveLength(1);
  const announcements = h.send.mock.calls.length;
  const other = { ...h.native, nativeId: 'another', name: 'AA-另一个会话' }; h.provider.list.mockResolvedValue([h.native, other]);
  const choices = await h.consoleService.snapshot(true), next = choices.sharedTargets.find(t => t.name === other.name)!;
  expect((await h.request('/api/console/action', { action: 'shared-bind', id: after.sharedGroups[0]!.id, target: next.id })).status).toBe(200);
  expect(h.bindings.get('oc_shared')?.nativeId).toBe('another'); expect(h.bindings.get('oc_group')?.nativeId).toBe('native');
  expect(h.send).toHaveBeenCalledTimes(announcements);
  expect((await h.request('/api/console/action', { action: 'shared-leave', id: after.sharedGroups[0]!.id })).status).toBe(409);
  const current = (await h.consoleService.snapshot(true)).sharedGroups[0]!;
  const stop = vi.fn(async () => false); h.controls.workerRuntimes!.get(tool)!.replies = { runNow: async () => {}, stopScope: stop };
  expect((await h.request('/api/console/action', { action: 'shared-leave', id: current.id })).status).toBe(200);
  expect(stop).toHaveBeenCalledWith('oc_shared'); expect(groups.get('oc_shared')!.status).toBe('archived');
  expect((await h.consoleService.snapshot(true)).sharedGroups[0]).toMatchObject({ associationId: next.id, targetId: undefined });
  expect(vi.mocked(h.channel.rawClient.im.v1.chatMembers.delete)).toHaveBeenCalledWith({ path: { chat_id: 'oc_shared' }, params: { member_id_type: 'app_id' }, data: { id_list: ['cli_test'] } });
  expect(h.provider.archive).not.toHaveBeenCalled(); expect(h.bindings.get('oc_group')?.nativeId).toBe('native');
});

it('console refuses shared switches with pending messages, late worker acceptance, unknown targets or changed owner', async () => {
  const h = await harness(); await h.replies.stop(); const groups = await managedShared(h), row = groups.get('oc_shared')!;
  await groups.bindSession(row.chatId, row.ownerId, row.generation, { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'native' }, async () => {});
  const other = { ...h.native, nativeId: 'another', name: 'another' }; h.provider.list.mockResolvedValue([h.native, other]);
  let snapshot = await h.consoleService.snapshot(true); const id = snapshot.sharedGroups[0]!.id, target = snapshot.sharedTargets.find(t => t.name === 'another')!.id;
  const message = { messageId: 'shared-pending-switch', chatId: 'oc_shared', content: '原消息', createTime: Date.now(), resources: [] } as unknown as NormalizedMessage;
  await h.inbox.receive('oc_shared', message);
  expect((await h.request('/api/console/action', { action: 'shared-bind', id, target })).status).toBe(409);
  expect(h.inbox.available()).toHaveLength(1); expect(h.bindings.get('oc_shared')?.nativeId).toBe('native');
  await h.inbox.rejectScope('oc_shared');
  const job = await h.client.submit({ requestKey: 'shared-late-acceptance', options: { ...h.options, delivery: { ...h.options.delivery!, scope: 'oc_shared', chatId: 'oc_shared', messageIds: ['late'] } } });
  const listed = await h.client.list(), active = listed.find(j => j.id === job.id)!;
  const list = vi.spyOn(h.client, 'list').mockResolvedValueOnce([]).mockResolvedValueOnce([active]);
  expect((await h.request('/api/console/action', { action: 'shared-bind', id, target })).status).toBe(409); list.mockRestore();
  expect(h.bindings.get('oc_shared')?.nativeId).toBe('native');
  expect((await h.request('/api/console/action', { action: 'shared-bind', id, target: '0'.repeat(64) })).status).toBe(409);
  h.controls.botOwnerId = 'ou_other'; snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.sharedGroups[0]).toMatchObject({ canBind: false, canLeave: false });
  expect((await h.request('/api/console/action', { action: 'shared-leave', id })).status).toBe(409);
});

it('console keeps shared leave failures recoverable and rejects cross-site or unauthenticated management', async () => {
  const h = await harness('kilo', '127.0.0.2'); await h.replies.stop(); const groups = await managedShared(h), row = groups.get('oc_shared')!;
  await groups.bindSession(row.chatId, row.ownerId, row.generation, { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'native' }, async () => {});
  const id = (await h.consoleService.snapshot(true)).sharedGroups[0]!.id;
  expect((await h.request('/api/console/action', { action: 'shared-leave', id })).status).toBe(401);
  await h.login(); expect((await h.request('/api/console/action', { action: 'shared-leave', id }, { Origin: 'http://evil.test' })).status).toBe(403);
  h.controls.workerRuntimes!.get('kilo')!.replies = { runNow: async () => {}, stopScope: async () => false };
  vi.mocked(h.channel.rawClient.im.v1.chatMembers.delete).mockResolvedValueOnce({ code: 999 } as any);
  expect((await h.request('/api/console/action', { action: 'shared-leave', id })).status).toBe(409);
  expect(groups.get('oc_shared')?.status).toBe('leaving');
  expect((await h.request('/api/console/action', { action: 'shared-leave', id })).status).toBe(200);
  expect(groups.get('oc_shared')?.status).toBe('archived'); expect(h.provider.archive).not.toHaveBeenCalled();
});

it('console preserves historical missing or unknown receipts without counting them as active work or replaying them during a switch', async () => {
  const h = await harness(); await h.replies.stop(); const groups = await managedShared(h), row = groups.get('oc_shared')!;
  await groups.bindSession(row.chatId, row.ownerId, row.generation, { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'native' }, async () => {});
  const message = { messageId: 'historic-accepted', chatId: 'oc_shared', content: '历史消息', createTime: 1, resources: [] } as unknown as NormalizedMessage;
  await h.inbox.receive('oc_shared', message);
  const historic = { id: 'historic-job', version: 1, requestKey: 'historic', fingerprint: 'historic', status: 'completed', createdAt: 1, updatedAt: 2,
    options: { ...h.options, delivery: { ...h.options.delivery!, scope: 'oc_shared', messageIds: [message.messageId] } } } as import('../../../src/worker/protocol').WorkerJob;
  await h.inbox.reconcile([historic]);
  const other = { ...h.native, nativeId: 'another', name: 'AA-new' }; h.provider.list.mockResolvedValue([h.native, other]);
  let snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.items.find(i => i.scope === 'oc_shared')?.status).toBe('accepted_unconfirmed');
  expect(snapshot.sharedGroups[0]).toMatchObject({ busy: false, canBind: true });
  vi.spyOn(h.client, 'list').mockResolvedValue([{ ...historic, status: 'unknown' }]);
  snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.items.find(i => i.scope === 'oc_shared')?.status).toBe('unknown');
  expect(snapshot.sharedGroups[0]).toMatchObject({ busy: false, canBind: true });
  expect((await h.request('/api/console/action', { action: 'shared-bind', id: snapshot.sharedGroups[0]!.id, target: snapshot.sharedTargets.find(t => t.name === 'AA-new')!.id })).status).toBe(200);
  expect(h.bindings.get('oc_shared')?.nativeId).toBe('another'); expect(h.inbox.receipts('oc_shared')[0]?.status).toBe('accepted'); expect(h.calls).toHaveLength(0);
});


it.each(['codex', 'claude', 'zcode', 'kilo', 'dsh'] as const)('AI group management reconciles both sides of %s through the same interfaces and retains dissolved associations', async tool => {
  const h = await harness(tool); await h.replies.stop();
  let row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row).toMatchObject({ groupState: 'active', sessionState: 'active', canDissolve: false, canArchive: false });
  expect((await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id })).status).toBe(409);
  h.native.archived = true;
  row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row).toMatchObject({ groupState: 'active', sessionState: 'archived', canDissolve: true, canArchive: false });
  const deletion = vi.spyOn(h.channel.rawClient.im.v1.chat, 'delete');
  expect((await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id })).status).toBe(200);
  expect(deletion).toHaveBeenCalledTimes(1); expect(h.bindings.get('oc_group')).toBeUndefined();
  h.catalog.gc({ now: Date.now() + 100 * 86400_000 }); await h.catalog.flush();
  const restored = new SessionCatalog(join(h.dir, 'catalog.json')); await restored.load();
  expect(restored.dissolvedPersonalGroups()).toHaveLength(1);
  row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row).toMatchObject({ groupState: 'dissolved', sessionState: 'archived', canDissolve: false, canArchive: false, groupName: 'AA-web', cwd: '/project' });
  h.native.archived = false;
  row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row).toMatchObject({ groupState: 'dissolved', sessionState: 'active', canDissolve: false, canArchive: true });
  expect((await h.request('/api/console/action', { action: 'personal-archive', id: row.id })).status).toBe(200);
  expect(h.provider.archive).toHaveBeenCalledWith('native');
  expect((await h.consoleService.snapshot(true)).bindings[0]).toMatchObject({ sessionState: 'archived', canArchive: false });
  expect((await h.request('/api/console/action', { action: 'personal-archive', id: row.id })).status).toBe(409);
  expect(h.provider.archive).toHaveBeenCalledTimes(1); expect(h.calls).toHaveLength(0);
});

it('AI group management excludes shared, private and topic routes and shows one row for each last personal binding', async () => {
  const h = await harness(); await h.replies.stop(); await managedShared(h);
  h.bindings.set('oc_group:topic', { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'topic' });
  h.bindings.set('oc_private', { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'private', auxiliaryWorkgroup: true });
  const snapshot = await h.consoleService.snapshot(true);
  expect(snapshot.bindings.map(b => b.scope)).toEqual(['oc_group']);
  expect(snapshot.sharedGroups.map(g => g.chatId)).toContain('oc_shared');
});

it.each(['permission', 'network', 'missing-data', 'worker', 'identity'] as const)('AI group actions fail closed for %s state instead of treating uncertainty as dissolution', async failure => {
  const h = await harness(); await h.replies.stop();
  const get = vi.spyOn(h.channel.rawClient.im.v1.chat, 'get');
  if (failure === 'permission') get.mockResolvedValue({ code: 232011, msg: 'not a member' });
  if (failure === 'network') get.mockRejectedValue(Error('timeout'));
  if (failure === 'missing-data') get.mockResolvedValue({ code: 0 });
  if (failure === 'worker') vi.spyOn(h.client, 'listSessions').mockRejectedValue(Error('roster unavailable'));
  if (failure === 'identity') h.controls.toolRegistry!.find('kilo')!.sourceId = 'other-worker';
  const row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row.canArchive).toBe(false); expect(row.canDissolve).toBe(false);
  expect((await h.request('/api/console/action', { action: 'personal-archive', id: row.id })).status).toBe(409);
  expect(vi.mocked(h.channel.rawClient.im.v1.chat.delete)).not.toHaveBeenCalled(); expect(h.provider.archive).not.toHaveBeenCalled();
});

it.each(['returned', 'thrown', 'status'] as const)('AI group management recognizes proven dissolution (%s) before the cleanup scan runs', async kind => {
  const h = await harness(); await h.replies.stop(); const get = vi.spyOn(h.channel.rawClient.im.v1.chat, 'get');
  if (kind === 'returned') get.mockResolvedValue({ code: 232009 });
  if (kind === 'thrown') get.mockRejectedValue({ response: { data: { code: 232009 } } });
  if (kind === 'status') get.mockResolvedValue({ code: 0, data: { chat_status: 'dissolved_save' } });
  const row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row).toMatchObject({ groupState: 'dissolved', sessionState: 'active', canArchive: true, canDissolve: false });
});

it('AI group deletion failures preserve the binding, and stale or unauthorized actions cannot target a replacement', async () => {
  const h = await harness('kilo', '127.0.0.2', { trustedNetworks: [] }); await h.replies.stop(); h.native.archived = true;
  const row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect((await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id })).status).toBe(401);
  await h.login(); expect((await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id }, { Origin: 'http://evil.test' })).status).toBe(403);
  const deletion = vi.spyOn(h.channel.rawClient.im.v1.chat, 'delete').mockResolvedValue({ code: 232017 });
  const denied = await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id });
  expect(denied.status).toBe(409); expect(await denied.text()).toContain('机器人没有解散此群的权限');
  expect(h.bindings.get('oc_group')).toBeDefined(); expect(h.catalog.isChatDissolved('oc_group')).toBe(false);
  h.bindings.set('oc_group', { toolId: 'kilo', sourceId: h.client.sourceId, nativeId: 'replacement' });
  expect((await h.request('/api/console/action', { action: 'personal-dissolve', id: row.id })).status).toBe(409);
  expect(deletion).toHaveBeenCalledTimes(1);
});

it('disables group deletion on offline or unreadable workers even with an old confirmed archive marker', async () => {
  const h = await harness(); await h.replies.stop(); h.bindings.archive('kilo', h.client.sourceId, 'native');
  const list = vi.spyOn(h.client, 'listSessions').mockRejectedValue(Error('unreadable'));
  let row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect(row.canDissolve).toBe(false);
  list.mockRestore(); vi.spyOn(h.client, 'health').mockRejectedValue(Error('offline'));
  row = (await h.consoleService.snapshot(true)).bindings[0]!; expect(row.canDissolve).toBe(false);
});

it('archives a proven dissolved chat before scanning without enqueueing a notification to it', async () => {
  const h = await harness(); await h.replies.stop();
  vi.spyOn(h.channel.rawClient.im.v1.chat, 'get').mockResolvedValue({ code: 232009 });
  const row = (await h.consoleService.snapshot(true)).bindings[0]!;
  expect((await h.request('/api/console/action', { action: 'personal-archive', id: row.id })).status).toBe(200);
  expect(h.catalog.pendingArchiveNotifications()).toHaveLength(0); expect(h.catalog.isChatDissolved('oc_group')).toBe(true);
  expect(h.catalog.dissolvedPersonalGroups()).toHaveLength(1); expect(h.bindings.get('oc_group')).toBeUndefined();
});
