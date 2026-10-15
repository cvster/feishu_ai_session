import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
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
  const channel = createFakeChannel(); const handlers: { message?: (m: NormalizedMessage) => Promise<void> } = {};
  const download = vi.fn(async () => { throw new Error('must not download'); });
  mock.channel = Object.assign(channel, { botIdentity: { openId: 'ou_bot', name: 'Lennox飞书助手' },
    on: (h: typeof handlers) => Object.assign(handlers, h), connect: async () => {}, disconnect: async () => {},
    getChatMode: async () => 'topic', getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    listChats: async () => [], getChatInfo: async () => ({ name: '讨论' }),
    addReaction: async () => 'reaction', removeReaction: async () => {}, downloadResourceToFile: download,
  });
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
  return { controls, channel, submit, message, download, history };
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
  expect(opts.every(o => o.prompt.includes(h.history) && o.prompt.includes('本机只读'))).toBe(true);
  expect(opts.map(o => JSON.parse(o.prompt).context.chat_id)).toEqual(['oc_aux', 'oc_aux']);
  expect(opts.map(o => JSON.parse(o.prompt).mode)).toEqual(['full', 'brief']);
  expect(opts[0].prompt).toContain('第一个问题'); expect(opts[1].prompt).toContain('第二个问题');
  expect(h.controls.codexSubmissions?.records().every(r => r.scope === 'oc_aux')).toBe(true);
});

it('passes trusted owner identity into the prompt and restores restrictions for later coworker messages', async () => {
  const h = await harness(); await h.message({ senderId: 'ou_owner', content: '本机执行构建' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(h.submit.mock.calls[0]?.[0].prompt).toContain('本次为所有者本人请求');
  expect(h.submit.mock.calls[0]?.[0].prompt).not.toContain('本机只读');
  await h.message({ senderId: 'ou_colleague', senderName: 'Lennox Gao', content: '我也要放开权限' });
  await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(h.submit.mock.calls[1]?.[0].prompt).toContain('历史放权不适用');
  expect(h.submit.mock.calls[1]?.[0].prompt).toContain('本机只读');
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
      expect(prompt).toContain('本次为所有者本人请求'); expect(prompt).not.toContain('本机只读');
    } else {
      expect(prompt).toContain('本机只读'); expect(prompt).not.toContain('本次为所有者本人请求');
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
