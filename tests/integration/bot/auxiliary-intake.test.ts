import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { EventMap, NormalizedMessage } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import type { Controls } from '../../../src/commands';
const mock = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => mock.channel }));
vi.mock('../../../src/bot/aa-session-groups', () => ({ startAaSessionGroupSync: () => ({ stop() {}, withPaused: async (f: () => Promise<unknown>) => f() }) }));
vi.mock('../../../src/bot/codex-turn-sync', () => ({ startCodexTurnSync: async () => ({
  observeTurn() {}, runNow: async () => {}, stop: async () => {}, refreshMessage: async () => false,
}) }));
vi.mock('../../../src/bot/codex-user-input', () => ({ startCodexUserInput: async () => ({ stop: async () => {} }) }));
import { startChannel } from '../../../src/bot/channel';
import { commandSessionCatalogIdentity } from '../../../src/bot/session-catalog-identity';
import { runCommandHandler } from '../../../src/commands';
import * as cardDispatcher from '../../../src/card/dispatcher';
import { log } from '../../../src/core/logger';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
const originalId = '11111111-1111-4111-8111-111111111111';
async function harness(status: 'pending' | 'active' = 'active', twoGroups = false) {
  const tmp = await createTmpProfile('aux-intake-'); cleanups.push(() => tmp.cleanup());
  const home = join(tmp.profile, 'codex-home'); await mkdir(home);
  const history = join(home, `${originalId}.jsonl`); await writeFile(history, 'source');
  const source = { toolId: 'codex' as const, sourceId: home, nativeId: originalId, historyPath: history };
  const bindings = new ToolBindingStore(join(tmp.profile, 'tool-bindings.json')); await bindings.load();
  if (status === 'active') {
    bindings.set('aux_shared', { toolId: 'codex', sourceId: home, name: 'FF-原会话', nativeCreated: false, linkedSource: source });
    bindings.linkAuxiliary('oc_aux', 'aux_shared');
    if (twoGroups) bindings.linkAuxiliary('oc_aux_2', 'aux_shared');
  }
  await bindings.flush();
  await writeFile(join(tmp.profile, 'auxiliary-groups.json'), JSON.stringify({ version: 1, appId: 'cli_test', groups: {
    oc_aux: { chatId: 'oc_aux', name: '讨论', generation: 'generation', ownerId: 'ou_owner', status, notified: true,
      ...(status === 'active' ? { source, cwd: tmp.workspace } : {}) },
    ...(twoGroups ? { oc_aux_2: { chatId: 'oc_aux_2', name: '第二群', generation: 'generation-b', ownerId: 'ou_owner', status, notified: true, source, cwd: tmp.workspace } } : {}),
  } }));
  const channel = createFakeChannel(); const handlers: Partial<Pick<EventMap, 'message' | 'cardAction'>> = {};
  const download = vi.fn(async () => { throw new Error('must not download'); });
  mock.channel = Object.assign(channel, { botIdentity: { openId: 'ou_bot', name: '示例助手' },
    on: (h: typeof handlers) => Object.assign(handlers, h), connect: async () => {}, disconnect: async () => {},
    getChatMode: async () => 'topic', getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    listChats: async () => [], getChatInfo: async () => ({ name: '讨论' }),
    addReaction: async () => 'reaction', removeReaction: async () => {}, downloadResourceToFile: download,
  });
  const memberGet = vi.fn(async () => ({ code: 0, data: { items: [{ member_id: 'ou_colleague' }, { member_id: 'ou_owner' }] } }));
  const createGroup = vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { chat_id: 'oc_privategroup' } }));
  Object.assign(channel.rawClient.im.v1.chat, { get: async () => ({ code: 0, data: { name: 'C系列-Agent对话', chat_mode: 'group' } }), create: createGroup });
  Object.assign(channel.rawClient.im.v1, { chatMembers: { get: memberGet } });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', codexHome: home }, access: { allowedChats: [], allowedUsers: ['ou_owner'], requireMentionInGroup: false },
    preferences: { messageReply: 'card' },
  }); profile.workspaces.default = tmp.workspace;
  const controls = { profile: 'codex', profileConfig: profile, cfg: profile, configPath: join(tmp.profile, 'config.json'),
    botOwnerId: 'ou_owner', ownerRefreshState: 'ok', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  } as unknown as Controls;
  const submit = vi.fn(async (_opts: any) => {});
  const agent = new FakeAgentAdapter({ id: 'codex' });
  agent.run = opts => ({ runId: opts.runId, stop: async () => {}, waitForExit: async () => true, events: { async *[Symbol.asyncIterator]() {
    await submit(opts);
    yield { type: 'system' as const, threadId: originalId, turnId: opts.runId, cwd: opts.cwd };
    yield { type: 'done' as const, threadId: originalId, terminationReason: 'normal' as const };
  } } });
  const stateDir = join(tmp.profile, 'workers', 'any-directory');
  const worker = await startWorkerServer({ stateDir, agent, sourceId: home, botAppId: 'cli_test', manifest: { label: 'Codex', nativeField: 'threadId', sessionKind: 'codex-thread', historyFormat: 'jsonl', nativeHistory: false },
    sessions: { list: async () => [{ nativeId: originalId, name: 'AA-original', cwd: tmp.workspace, createdAtMs: 1, updatedAtMs: 2 }], history: async id => ({ nativeId: id, content: 'source', format: 'jsonl' }) } });
  cleanups.push(() => worker.close());
  const client = new WorkerClient(stateDir, home, 'cli_test', 'codex');
  const records = async () => (await client.list()).map(job => ({ scope: job.options.delivery!.scope, replyTo: job.options.delivery!.replyTo, status: job.status }));
  const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const bridge = await startChannel({ cfg: profile, controls, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    sessionCatalog: catalog, workspaces,
    appPaths: { profileDir: tmp.profile, mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secret'), keystoreSaltFile: join(tmp.profile, 'salt') },
  }); cleanups.push(() => bridge.disconnect());
  let count = 0;
  async function message(overrides: Partial<NormalizedMessage> = {}) {
    await handlers.message!({ messageId: `om_${++count}`, chatId: 'oc_aux', chatType: 'group', threadId: 'topic-a', senderId: 'ou_colleague',
      content: '同事的问题', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: Date.now(), ...overrides });
  }
  const cardAction = (cmd: string, chatId = 'oc_callback') => handlers.cardAction!({
    messageId: `om_${cmd}`, chatId, operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { cmd } },
  });
  return { controls, channel, submit, records, message, cardAction, download, history, memberGet, createGroup, catalog, workspaces, cwd: tmp.workspace, approvalsPath: join(tmp.profile, 'ff-approvals.json') };
}
it.each(['stop', 'config', 'refresh', 'fork', 'finish'])('acknowledges %s before slow card processing and completes it once', async cmd => {
  const h = await harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const finished = vi.fn();
  const dispatch = vi.spyOn(cardDispatcher, 'handleCardAction').mockImplementationOnce(async () => {
    await blocked;
    finished();
  });
  // No timeout/race helper: the transport must get a synchronous JSON object
  // even when the action never resolves until explicitly released below.
  expect(h.cardAction(cmd)).toEqual({});
  expect(dispatch).not.toHaveBeenCalled();
  try {
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]![0].evt.action.value).toEqual({ cmd });
    expect(finished).not.toHaveBeenCalled();
  } finally { release(); }
  await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(dispatch).toHaveBeenCalledOnce();
});
it('acknowledges before permission confirmation I/O and retains its failure notice', async () => {
  const h = await harness();
  let fail!: (error: Error) => void;
  const blocked = new Promise<boolean>((_resolve, reject) => { fail = reject; });
  const approval = vi.spyOn(h.controls.auxiliaryApprovals!, 'action').mockImplementationOnce(() => blocked);
  const dispatch = vi.spyOn(cardDispatcher, 'handleCardAction');
  expect(h.cardAction('auxiliary.approval')).toEqual({});
  expect(approval).not.toHaveBeenCalled();
  try { await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce()); }
  finally { fail(new Error('confirmation unavailable')); }
  await vi.waitFor(() => expect(h.channel.sent.some(m => m.chatId === 'ou_owner' &&
    JSON.stringify(m.content).includes('权限确认处理未完成'))).toBe(true));
  expect(dispatch).not.toHaveBeenCalled();
});
it('contains detached card failures after acknowledgement and still handles another click', async () => {
  const h = await harness();
  const error = new Error('card lookup unavailable');
  const failure = vi.spyOn(log, 'fail').mockImplementation(() => {});
  const dispatch = vi.spyOn(cardDispatcher, 'handleCardAction').mockRejectedValueOnce(error).mockResolvedValue(undefined);
  expect(h.cardAction('config')).toEqual({});
  await vi.waitFor(() => expect(failure).toHaveBeenCalledWith('cardAction', error));
  expect(h.cardAction('refresh')).toEqual({});
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
});
it('accepts direct owner messages in the FF personal workgroup using the original session and normal permissions', async () => {
  const h = await harness();
  const original = h.controls.toolBindings!.get('oc_aux')!;
  h.controls.toolBindings!.set('oc_ffowner', { toolId: 'codex', sourceId: original.sourceId,
    nativeId: originalId, nativeCreated: true, name: 'FF-原会话', auxiliaryWorkgroup: true });
  h.workspaces.setCwd('oc_ffowner', h.cwd);
  const msg = { chatId: 'oc_ffowner', senderId: 'ou_owner', chatType: 'group' } as NormalizedMessage;
  const identity = await commandSessionCatalogIdentity({ msg, scope: 'oc_ffowner', mode: 'group', workspaces: h.workspaces,
    controls: h.controls, access: { ok: true, reason: 'owner' } });
  h.catalog.upsertActive({ ...identity!, sourceId: original.sourceId, threadId: originalId, botAppId: 'cli_test' });
  await h.message({ chatId: 'oc_ffowner', senderId: 'ou_owner', threadId: undefined, mentionedBot: false, content: '直接继续本次调试' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(h.submit.mock.calls[0]![0]).toMatchObject({ threadId: originalId });
  expect(h.submit.mock.calls[0]![0].prompt).toContain('当前飞书应用所有者本人请求');
  expect(h.submit.mock.calls[0]![0].prompt).toContain('直接继续本次调试');
  expect(h.controls.auxiliary?.isAuxiliary('oc_ffowner')).toBe(false);
});
it('routes a copied-session read through normal intake and the durable Codex submission queue', async () => {
  const h = await harness(); const sourceId = h.controls.toolRegistry!.get('codex').sourceId;
  const copiedFrom = { copyId: 'copy-test', toolId: 'codex' as const, sourceId, nativeId: originalId, name: '来源会话', cwd: h.cwd };
  h.controls.toolBindings!.set('oc_copy', { toolId: 'codex', sourceId, nativeCreated: false, name: '新会话', copiedFrom });
  h.workspaces.setCwd('oc_copy', h.cwd);
  h.controls.toolRegistry!.get('codex').sessions = { historyPath: async () => h.history, rename: async () => {}, archive: async () => {} };
  const ctx = { channel: h.channel, controls: h.controls, scope: 'oc_copy', chatMode: 'group' as const, fromCardAction: true,
    msg: { messageId: 'om_provenance', chatId: 'oc_copy', chatType: 'group', senderId: 'ou_owner' },
    workspaces: h.workspaces, sessionCatalog: h.catalog } as any;
  await runCommandHandler('fork', 'read copy-test', ctx);
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(h.submit.mock.calls[0]![0].prompt).toContain("/来源会话' 的内容");
  expect(h.submit.mock.calls[0]![0].prompt).toContain(h.history);
  expect(h.submit.mock.calls[0]![0].threadId).not.toBe(originalId);
  expect((await h.records()).find(r => r.scope === 'oc_copy')?.replyTo).toBe('om_provenance');
  await runCommandHandler('fork', 'read copy-test', ctx);
  await new Promise(r => setTimeout(r, 100)); expect(h.submit).toHaveBeenCalledOnce();
});
it('ignores non-mentions, @all and bot senders even when global mention requirement is off', async () => {
  const h = await harness(); await h.message({ mentionedBot: false }); await h.message({ mentionedBot: false, mentionAll: true });
  await h.message({ raw: { sender: { sender_type: 'app' } } });
  await h.message({ senderId: 'ou_bot' });
  expect((await h.records())).toHaveLength(0); expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
});
it('accepts any human without a mention in a bound personal group, regardless of membership counts', async () => {
  const h = await harness();
  h.controls.profileConfig.access.requireMentionInGroup = true;
  const sourceId = h.controls.toolRegistry!.get('codex').sourceId;
  h.controls.toolBindings!.set('oc_personal', { toolId: 'codex', sourceId, nativeId: originalId, nativeCreated: true });
  h.workspaces.setCwd('oc_personal', h.cwd);
  const get = vi.fn(async () => ({ code: 0, data: { user_count: '12', bot_count: '2' } }));
  Object.assign(h.channel.rawClient.im.v1.chat, { get });
  Object.assign(h.channel, { getChatMode: async () => 'group' });
  for (const senderId of ['ou_colleague', 'ou_second']) {
    await h.message({ chatId: 'oc_personal', threadId: undefined, mentionedBot: false, senderId, content: `继续 ${senderId}` });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(senderId === 'ou_colleague' ? 1 : 2), { timeout: 3000 });
  }
  expect(h.submit.mock.calls.every(([options]) => options.threadId === originalId)).toBe(true);
  await h.message({ chatId: 'oc_personal', threadId: undefined, mentionedBot: false, senderId: 'ou_bot' });
  await h.message({ chatId: 'oc_aux', mentionedBot: false });
  expect(h.submit).toHaveBeenCalledTimes(2);
  expect(get).not.toHaveBeenCalled(); // No sole-member exception lookup.
});
it('silently ignores later messages, commands and attachments after the group is archived', async () => {
  const h = await harness(); h.catalog.archiveScope('oc_aux', 'archived');
  const sent = h.channel.sent.length;
  await h.message({ content: '继续处理' });
  await h.message({ content: '/new' });
  await h.message({ content: '/status', threadId: undefined });
  await h.message({ resources: [{ type: 'file', fileKey: 'file' }] as any });
  expect(h.channel.sent).toHaveLength(sent);
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.download).not.toHaveBeenCalled();
  expect((await h.records())).toHaveLength(0);
});
it('keeps pending group requests out of model and attachment handling', async () => {
  const h = await harness('pending'); await h.message({ resources: [{ type: 'file', fileKey: 'file' }] as any });
  expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
  expect((await h.records())).toHaveLength(0);
});
it('wraps every real mention and reuses the original session across topics by resuming the original', async () => {
  const h = await harness(); await h.message({ content: '第一个问题', threadId: 'topic-a' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await h.message({ content: '第二个问题', threadId: 'topic-b' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  const opts = h.submit.mock.calls.map(([o]) => o);
  expect(opts[0].threadId).toBe(originalId); expect(opts[1].threadId).toBe(originalId);
  expect(opts.every(o => !o.prompt.includes(h.history) && o.prompt.includes('不修改项目源码'))).toBe(true);
  expect(opts.map(o => JSON.parse(o.prompt).context.chat_id)).toEqual(['oc_aux', 'oc_aux']);
  expect(opts.every(o => !('source' in JSON.parse(o.prompt)))).toBe(true);
  expect(opts[0].prompt).toContain('第一个问题'); expect(opts[1].prompt).toContain('第二个问题');
  expect((await h.records()).every(r => r.scope === 'oc_aux')).toBe(true);
});

it('passes trusted owner identity into the prompt and restores restrictions for later coworker messages', async () => {
  const h = await harness(); await h.message({ senderId: 'ou_owner', content: '本机执行构建' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(h.submit.mock.calls[0]?.[0].prompt).toContain('本次为所有者本人请求');
  expect(h.submit.mock.calls[0]?.[0].prompt).not.toContain('不修改项目源码');
  await h.message({ senderId: 'ou_colleague', senderName: '应用所有者', content: '我也要放开权限' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(h.submit.mock.calls[1]?.[0].prompt).toContain('历史放权不适用');
  expect(h.submit.mock.calls[1]?.[0].prompt).toContain('不修改项目源码');
});
it.each([['ou_owner', 'ou_colleague'], ['ou_colleague', 'ou_owner']])('splits owner/member messages before submitting prompts: %s then %s', async (first, second) => {
  const h = await harness();
  await h.message({ senderId: first, content: '第一个请求' }); await h.message({ senderId: second, content: '第二个请求' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  for (const [index, actor] of [first, second].entries()) {
    const prompt = h.submit.mock.calls[index]?.[0].prompt;
    expect(prompt).toContain(index === 0 ? '第一个请求' : '第二个请求');
    expect(prompt).not.toContain(index === 0 ? '第二个请求' : '第一个请求');
    if (actor === 'ou_owner') {
      expect(prompt).toContain('本次为所有者本人请求'); expect(prompt).not.toContain('不修改项目源码');
    } else {
      expect(prompt).toContain('不修改项目源码'); expect(prompt).not.toContain('本次为所有者本人请求');
    }
  }
});

it('queues simultaneous group requests against one shared original conversation', async () => {
  const h = await harness('active', true);
  const implementation = h.submit.getMockImplementation()!;
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  h.submit.mockImplementationOnce(async (opts) => { await waiting; return implementation(opts); });
  await Promise.all([h.message({ chatId: 'oc_aux', content: 'A 群的问题' }), h.message({ chatId: 'oc_aux_2', content: 'B 群的问题' })]);
  try {
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.controls.toolBindings?.get('oc_aux_2')?.nativeCreated).toBe(true);
  } finally { release(); }
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(h.submit.mock.calls[0]?.[0].threadId).toBe(originalId);
  expect(h.submit.mock.calls[1]?.[0].threadId).toBe(originalId);
  expect(h.submit.mock.calls.every(([opts]) => opts.threadId === originalId)).toBe(true);
  expect(JSON.parse(h.submit.mock.calls[0]?.[0].prompt).context.chat_id).toBe('oc_aux');
  expect(JSON.parse(h.submit.mock.calls[1]?.[0].prompt).context.chat_id).toBe('oc_aux_2');
  expect((await h.records()).map(r => r.scope).sort()).toEqual(['oc_aux', 'oc_aux_2']);
  expect(h.controls.toolBindings?.get('oc_aux')?.nativeId).toBe(h.controls.toolBindings?.get('oc_aux_2')?.nativeId);
});


it('creates a private group only for an actual human @bot 私聊 without invoking the model', async () => {
  const h = await harness();
  await h.message({ content: '私聊', mentionedBot: false });
  await h.message({ content: '私聊', mentionAll: true });
  await h.message({ content: '私聊', raw: { sender: { sender_type: 'app' } } });
  expect(h.createGroup).not.toHaveBeenCalled();
  await h.message({ content: '私聊' });
  expect(h.createGroup).toHaveBeenCalledOnce();
  expect(h.createGroup.mock.calls[0]![0]).toMatchObject({ data: { name: '私聊-C系列-Agent对话', user_id_list: ['ou_owner', 'ou_colleague'] } });
  expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
  expect((await h.records())).toHaveLength(0);
  await h.message({ content: '私聊' }); expect(h.createGroup).toHaveBeenCalledOnce();
  await h.message({ chatId: 'oc_privategroup', content: '私聊', threadId: undefined });
  expect(h.createGroup).toHaveBeenCalledOnce(); expect(h.submit).not.toHaveBeenCalled();
  expect(JSON.stringify(h.channel.sent)).toContain('已经是私聊群');
});
it('routes private group questions to the original while keeping replies and permissions in that group', async () => {
  const h = await harness(); await h.message({ content: '私聊' });
  await h.message({ chatId: 'oc_privategroup', threadId: undefined, content: '只在新群调试' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce(), { timeout: 3000 });
  const prompt = JSON.parse(h.submit.mock.calls[0]![0].prompt);
  expect(prompt.context).toMatchObject({ chat_id: 'oc_privategroup', actor: 'member' });
  expect(prompt.rules.permissions).toContain('不修改项目源码');
  expect(prompt.rules.delivery).toContain('不沿用历史群ID');
  expect(h.controls.toolBindings?.get('oc_privategroup')?.sharedScope).toBe(h.controls.toolBindings?.get('oc_aux')?.sharedScope);
  expect((await h.records())[0]?.scope).toBe('oc_privategroup');
  await h.message({ content: '在原群继续' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(h.submit.mock.calls[1]![0].threadId).toBe(originalId);
  expect(JSON.parse(h.submit.mock.calls[1]![0].prompt).context.chat_id).toBe('oc_aux');
});
it('returns a migration notice for retired bot-DM requests without entering the model or console', async () => {
  const h = await harness();
  for (const senderId of ['ou_colleague', 'ou_owner']) {
    await h.message({ senderId, chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: '/ff {broken' });
    await h.message({ senderId, chatId: 'oc_dm', chatType: 'p2p', content: JSON.stringify({ protocol: 'ff-dm-v1', question: 'do something' }) });
  }
  expect(h.submit).not.toHaveBeenCalled(); expect(h.createGroup).not.toHaveBeenCalled();
  expect((await h.records())).toHaveLength(0);
  expect(JSON.stringify(h.channel.sent)).toContain('旧私聊接口已停用');
});

it.each([false, true])('continues an approved FF request through the durable queue without granting neighboring messages (privateGroup=%s)', async privateEntry => {
  const h = await harness('active');
  if (privateEntry) await h.message({ content: '私聊' });
  const targetChat = privateEntry ? 'oc_privategroup' : 'oc_aux';
  const original = { chatId: targetChat, content: '请修改本机项目源码' };
  await h.message(original);
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  const initial = (await h.records())[0]!;
  const approvalText = JSON.stringify({ type: 'ff_permission_request', action: '修改本机项目源码 src/main.ts', reason: '修改本机项目源码受限' });
  await h.controls.auxiliaryApprovals!.review(initial.scope, 'turn-needs-approval', initial.replyTo,
    { blocks: [{ kind: 'text', content: approvalText, streaming: false }], terminal: 'done', reasoning: { content: '', active: false }, footer: null });
  const ledger = JSON.parse(await readFile(h.approvalsPath, 'utf8'));
  const approval = Object.values(ledger.approvals)[0] as any;
  const click = { chatId: targetChat, messageId: approval.cardMessageId,
    operator: { openId: 'ou_owner' }, action: { value: { cmd: 'auxiliary.approval', id: approval.id, decision: 'approve' } } };
  const originalMode = (h.channel as any).getChatMode;
  await h.controls.auxiliaryApprovals!.action(click as any);
  if (!privateEntry) await h.message({ content: '同事紧跟着的新问题' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(privateEntry ? 2 : 3), { timeout: 4000 });
  const continued = JSON.parse(h.submit.mock.calls[1]![0].prompt);
  expect(continued.context.actor).toBe('member');
  expect(continued.context.approval).toEqual({ id: approval.id, action: '修改本机项目源码 src/main.ts', ownerId: 'ou_owner' });
  expect(continued.context.chat_id).toBe(targetChat);
  expect(continued.rules.permissions).toContain('其余操作仍受限');
  if (!privateEntry) expect(JSON.parse(h.submit.mock.calls[2]![0].prompt).context.approval).toBeUndefined();
  await h.controls.auxiliaryApprovals!.action(click as any);
  expect(h.submit).toHaveBeenCalledTimes(privateEntry ? 2 : 3);
  (h.channel as any).getChatMode = originalMode;
});
