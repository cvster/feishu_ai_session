import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const originalId = '11111111-1111-4111-8111-111111111111';
async function harness(status: 'pending' | 'active' = 'active', twoGroups = false, allowPrivate = false) {
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
    oc_aux: { chatId: 'oc_aux', name: '讨论', generation: 'generation', ownerId: 'ou_owner', status, notified: true, allowPrivate, privateBindingId: 'private-entry',
      ...(status === 'active' ? { source, cwd: tmp.workspace } : {}) },
    ...(twoGroups ? { oc_aux_2: { chatId: 'oc_aux_2', name: '第二群', generation: 'generation-b', ownerId: 'ou_owner', status, notified: true, allowPrivate, privateBindingId: 'private-entry', source, cwd: tmp.workspace } } : {}),
  } }));
  const channel = createFakeChannel(); const handlers: { message?: (m: NormalizedMessage) => Promise<void> } = {};
  const download = vi.fn(async () => { throw new Error('must not download'); });
  mock.channel = Object.assign(channel, { botIdentity: { openId: 'ou_bot', name: '示例助手' },
    on: (h: typeof handlers) => Object.assign(handlers, h), connect: async () => {}, disconnect: async () => {},
    getChatMode: async () => 'topic', getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    listChats: async () => [], getChatInfo: async () => ({ name: '讨论' }),
    addReaction: async () => 'reaction', removeReaction: async () => {}, downloadResourceToFile: download,
  });
  const memberGet = vi.fn(async () => ({ code: 0, data: { items: [{ member_id: 'ou_colleague' }, { member_id: 'ou_owner' }] } }));
  Object.assign(channel.rawClient.im.v1.chat, { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) });
  Object.assign(channel.rawClient.im.v1, { chatMembers: { get: memberGet } });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', codexHome: home }, access: { allowedChats: [], allowedUsers: ['ou_owner'], requireMentionInGroup: false },
    preferences: { messageReply: 'card' },
  }); profile.workspaces.default = tmp.workspace;
  const controls = { profile: 'codex', profileConfig: profile, cfg: profile, configPath: join(tmp.profile, 'config.json'),
    botOwnerId: 'ou_owner', ownerRefreshState: 'ok', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  } as unknown as Controls;
  const agent = new FakeAgentAdapter({ id: 'codex' });
  const submit = vi.fn(async (opts: any, beforeSend: any) => {
    await beforeSend({ threadId: 'ff-independent', knownTurnIds: [], transport: 'rpc' });
    return { status: 'accepted' as const, submissionId: opts.runId, threadId: 'ff-independent', transport: 'rpc' as const };
  }); Object.assign(agent, { submit });
  const bridge = await startChannel({ cfg: profile, controls, agent, sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    sessionCatalog: new SessionCatalog(join(tmp.profile, 'catalog.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    appPaths: { profileDir: tmp.profile, mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secret'), keystoreSaltFile: join(tmp.profile, 'salt') },
  }); cleanups.push(() => bridge.disconnect());
  let count = 0;
  async function message(overrides: Partial<NormalizedMessage> = {}) {
    await handlers.message!({ messageId: `om_${++count}`, chatId: 'oc_aux', chatType: 'group', threadId: 'topic-a', senderId: 'ou_colleague',
      content: '同事的问题', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: Date.now(), ...overrides });
  }
  return { controls, channel, submit, message, download, history, memberGet, approvalsPath: join(tmp.profile, 'ff-approvals.json') };
}
it('ignores non-mentions, @all and bot senders even when global mention requirement is off', async () => {
  const h = await harness(); await h.message({ mentionedBot: false }); await h.message({ mentionedBot: false, mentionAll: true });
  await h.message({ raw: { sender: { sender_type: 'app' } } });
  await h.message({ senderId: 'ou_bot' });
  expect(h.controls.codexSubmissions?.records()).toHaveLength(0); expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
});
it('keeps pending group requests out of model and attachment handling', async () => {
  const h = await harness('pending'); await h.message({ resources: [{ type: 'file', fileKey: 'file' }] as any });
  expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
  expect(h.controls.codexSubmissions?.records()).toHaveLength(0);
});
it('wraps every real mention and reuses one FF session across topics without resuming the source', async () => {
  const h = await harness(); await h.message({ content: '第一个问题', threadId: 'topic-a' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await h.message({ content: '第二个问题', threadId: 'topic-b' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  const opts = h.submit.mock.calls.map(([o]) => o);
  expect(opts[0].threadId).toBeUndefined(); expect(opts[1].threadId).toBe('ff-independent');
  expect(opts.every(o => o.prompt.includes(h.history) && o.prompt.includes('不修改项目源码'))).toBe(true);
  expect(opts.map(o => JSON.parse(o.prompt).context.chat_id)).toEqual(['oc_aux', 'oc_aux']);
  expect(opts.map(o => JSON.parse(o.prompt).mode)).toEqual(['full', 'brief']);
  expect(opts[0].prompt).toContain('第一个问题'); expect(opts[1].prompt).toContain('第二个问题');
  expect(h.controls.codexSubmissions?.records().every(r => r.scope === 'oc_aux')).toBe(true);
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

it('queues simultaneous group requests against one shared FF native conversation', async () => {
  const h = await harness('active', true);
  const implementation = h.submit.getMockImplementation()!;
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  h.submit.mockImplementationOnce(async (opts, beforeSend) => { await waiting; return implementation(opts, beforeSend); });
  await Promise.all([h.message({ chatId: 'oc_aux', content: 'A 群的问题' }), h.message({ chatId: 'oc_aux_2', content: 'B 群的问题' })]);
  try {
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.controls.toolBindings?.get('oc_aux_2')?.nativeCreated).toBe(false);
  } finally { release(); }
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(h.submit.mock.calls[0]?.[0].threadId).toBeUndefined();
  expect(h.submit.mock.calls[1]?.[0].threadId).toBe('ff-independent');
  expect(h.submit.mock.calls.map(([opts]) => opts.sessionName)).toEqual(['FF-原会话', 'FF-原会话']);
  expect(JSON.parse(h.submit.mock.calls[0]?.[0].prompt).context.chat_id).toBe('oc_aux');
  expect(JSON.parse(h.submit.mock.calls[1]?.[0].prompt).context.chat_id).toBe('oc_aux_2');
  expect(h.controls.codexSubmissions?.records().map(r => r.scope).sort()).toEqual(['oc_aux', 'oc_aux_2']);
  expect(h.controls.toolBindings?.get('oc_aux')?.nativeId).toBe(h.controls.toolBindings?.get('oc_aux_2')?.nativeId);
});


function privateInput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ protocol: 'ff-dm-v1', bot_app_id: 'cli_test', group_id: 'oc_aux', binding_id: 'private-entry',
    request_id: 'debug-1', question: '只在私聊调试', ...overrides });
}
it('routes a coworker private request through the durable FF pipeline without opening ordinary DM access', async () => {
  const h = await harness('active', false, true);
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, mentionedBot: false, content: privateInput() });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  const prompt = JSON.parse(h.submit.mock.calls[0]?.[0].prompt);
  expect(prompt.context).toMatchObject({ chat_id: 'oc_dm', request_id: 'debug-1', channel: 'p2p', actor: 'member' });
  expect(prompt.rules.permissions).toContain('不修改项目源码'); expect(prompt.rules.delivery).toContain('禁止发送到任何群');
  const record = h.controls.codexSubmissions!.records()[0]!;
  expect(record.scope).toMatch(/^oc_dm:ffdm_/); expect(record.messages[0]?.chatId).toBe('oc_dm');
  expect(record.replyInThread).not.toBe(true);
  expect(h.controls.toolBindings?.get(record.scope)?.sharedScope).toBe(h.controls.toolBindings?.get('oc_aux')?.sharedScope);
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: '普通私聊不应进入FF' });
  expect(h.submit).toHaveBeenCalledTimes(1);
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: privateInput() });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.channel.sent)).toContain('不会重复执行');
  expect(h.channel.sent.every(m => m.chatId === 'oc_dm')).toBe(true);
});
it('rejects disabled entries, outsider identities and bot callers without submitting or resolving attachments', async () => {
  const off = await harness(); await off.message({ chatId: 'oc_dm', chatType: 'p2p', content: privateInput() });
  expect(off.submit).not.toHaveBeenCalled();
  const h = await harness('active', false, true);
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_outsider', content: privateInput() });
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', raw: { sender: { sender_type: 'app' } }, content: privateInput() });
  expect(h.submit).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
});
it('rechecks membership before queue execution and keeps commands inside question data', async () => {
  const h = await harness('active', false, true);
  h.memberGet.mockResolvedValueOnce({ code: 0, data: { items: [{ member_id: 'ou_colleague' }] } })
    .mockResolvedValue({ code: 0, data: { items: [] } });
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: privateInput({ question: '/cd /etc' }) });
  await vi.waitFor(() => expect(h.controls.codexSubmissions!.records()[0]?.status).toBe('rejected'), { timeout: 3000 });
  expect(h.submit).not.toHaveBeenCalled();
});
it('does not execute a private request stopped while it is still queued', async () => {
  const h = await harness('active', false, true);
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: privateInput() });
  await h.message({ chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, content: privateInput({ action: 'stop' }) });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.controls.codexSubmissions!.records()[0]?.status).toBe('rejected');
  expect(JSON.stringify(h.channel.sent)).toContain('已取消待处理输入');
});

it.each([false, true])('continues an approved FF request through the durable queue without granting neighboring messages (private=%s)', async privateEntry => {
  const h = await harness('active', false, true);
  const original = privateEntry ? { chatId: 'oc_dm', chatType: 'p2p' as const, threadId: undefined, mentionedBot: false, content: privateInput() } : { content: '请修改本机项目源码' };
  await h.message(original);
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  const initial = h.controls.codexSubmissions!.records()[0]!;
  const approvalText = JSON.stringify({ type: 'ff_permission_request', action: '修改本机项目源码 src/main.ts', reason: '修改本机项目源码受限' });
  await h.controls.auxiliaryApprovals!.review(initial.scope, 'turn-needs-approval', initial.replyTo,
    { blocks: [{ kind: 'text', content: approvalText, streaming: false }], terminal: 'done', reasoning: { content: '', active: false }, footer: null });
  const ledger = JSON.parse(await readFile(h.approvalsPath, 'utf8'));
  const approval = Object.values(ledger.approvals)[0] as any;
  const click = { chatId: privateEntry ? 'oc_owner_dm' : 'oc_aux', messageId: approval.cardMessageId,
    operator: { openId: 'ou_owner' }, action: { value: { cmd: 'auxiliary.approval', id: approval.id, decision: 'approve' } } };
  const originalMode = (h.channel as any).getChatMode;
  if (privateEntry) (h.channel as any).getChatMode = async () => 'p2p';
  await h.controls.auxiliaryApprovals!.action(click as any);
  if (!privateEntry) await h.message({ content: '同事紧跟着的新问题' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(privateEntry ? 2 : 3), { timeout: 4000 });
  const continued = JSON.parse(h.submit.mock.calls[1]![0].prompt);
  expect(continued.context.actor).toBe('member');
  expect(continued.context.approval).toEqual({ id: approval.id, action: '修改本机项目源码 src/main.ts', ownerId: 'ou_owner' });
  expect(continued.context.chat_id).toBe(privateEntry ? 'oc_dm' : 'oc_aux');
  expect(continued.rules.permissions).toContain('其余操作仍受限');
  if (!privateEntry) expect(JSON.parse(h.submit.mock.calls[2]![0].prompt).context.approval).toBeUndefined();
  await h.controls.auxiliaryApprovals!.action(click as any);
  expect(h.submit).toHaveBeenCalledTimes(privateEntry ? 2 : 3);
  (h.channel as any).getChatMode = originalMode;
});
