import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { AuxiliaryApprovals, parseApprovalRequest } from '../../../src/bot/auxiliary-approvals';
import { AuxiliaryGroups } from '../../../src/bot/auxiliary-groups';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ToolRegistry } from '../../../src/tools/types';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { startWorkerReplies } from '../../../src/worker/replies';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { initialState, type RunState } from '../../../src/card/run-state';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const requestText = JSON.stringify({ type: 'ff_permission_request', action: '修改本机项目源码 src/main.ts', reason: '修改本机项目源码受辅助权限限制' });
const state = (): RunState => ({ ...initialState, terminal: 'done', blocks: [{ kind: 'text', content: requestText, streaming: false }] });
async function setup(privateGroup = false, toolId: 'codex' | 'claude' = 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'ff-approval-')); dirs.push(dir);
  const path = join(dir, 'approvals.json'); const source = { toolId, sourceId: dir,
    nativeId: '11111111-1111-4111-8111-111111111111', historyPath: join(dir, 'history') }; await writeFile(source.historyPath, 'source');
  const bindings = new ToolBindingStore(join(dir, 'bindings')); await bindings.load();
  bindings.set('aux_shared', { toolId, sourceId: dir, nativeId: '11111111-1111-4111-8111-111111111111', nativeCreated: true, linkedSource: source, name: 'FF-test' });
  bindings.linkAuxiliary('oc_group', 'aux_shared'); await bindings.flush();
  const groupsPath = join(dir, 'groups'); await writeFile(groupsPath, JSON.stringify({ version: 1, appId: 'cli_bot', groups: {
    oc_group: { chatId: 'oc_group', name: '测试群', generation: 'g1', ownerId: 'ou_owner', status: 'active', source, cwd: dir },
  } }));
  let now = 1000; let owner = 'ou_owner'; let sent = 0;
  const cards: object[] = [];
  const create = vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { message_id: 'om_approval' } }));
  const send = vi.fn(async (..._args: unknown[]) => ({ messageId: `om_receipt_${++sent}` }));
  const update = vi.fn(async (..._args: unknown[]) => {});
  const channel = { botIdentity: { openId: 'ou_bot' }, createCard: vi.fn(async (card: object) => { cards.push(card); return { cardId: `card${cards.length}` }; }),
    send, updateCardById: update, getChatMode: async () => 'p2p', rawClient: { im: { v1: {
      chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', name: '测试群' } }), create: async () => ({ code: 0, data: { chat_id: 'oc_privategroup' } }) },
      chatMembers: { get: async () => ({ code: 0, data: { items: [{ member_id: 'ou_member' }, { member_id: 'ou_owner' }] } }) },
      message: { create },
    } } } } as unknown as LarkChannel;
  const tools = new ToolRegistry();
  tools.register({ id: toolId, label: toolId, sourceId: dir, agent: {} as any, listSessions: async () => [],
    sessions: { historyPath: async () => source.historyPath, rename: async () => {}, archive: async () => {} } });
  const auxiliary = new AuxiliaryGroups({ path: groupsPath, appId: 'cli_bot', channel, bindings, tools,
    sessions: new SessionStore(join(dir, 'sessions')), workspaces: new WorkspaceStore(join(dir, 'workspaces')),
    ownerId: () => owner, refreshOwner: async () => {}, cancelPending: async () => {} }); await auxiliary.load();
  const scope = privateGroup ? (await auxiliary.createPrivateGroup('oc_group', 'ou_member')).chatId : 'oc_group';
  send.mockClear();
  const message = { messageId: 'om_question', chatId: scope, chatType: 'group',
    senderId: 'ou_member', content: '请修改源码', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 1, rawContentType: 'text' } as NormalizedMessage;
  const resume = vi.fn(async (_r: unknown) => {});
  const deps = { path, channel, auxiliary, bindings, ownerId: () => owner, resume, now: () => now };
  const approvals = new AuxiliaryApprovals(deps); await approvals.load(); await approvals.remember(scope, [message], message.content);
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  async function approval() { return Object.values((await read()).approvals)[0] as any; }
  async function event(decision = 'approve', actor = 'ou_owner', messageId = 'om_approval', chatId = scope): Promise<CardActionEvent> {
    return { messageId, chatId, operator: { openId: actor }, action: { value: { cmd: 'auxiliary.approval', id: (await approval()).id, decision } } } as CardActionEvent;
  }
  return { dir, deps, auxiliary, bindings, approvals, scope, message, resume, channel, create, send, update, cards, read, approval, event,
    clock: (value: number) => { now = value; }, owner: (value: string) => { owner = value; } };
}
it('posts one group confirmation with a real owner mention and exactly two buttons', async () => {
  const h = await setup();
  const result = await h.approvals.review(h.scope, 'run-1', 'om_question', state());
  expect(JSON.stringify(result)).toContain('确认卡片'); expect(JSON.stringify(result)).not.toContain('ff_permission_request');
  expect(h.create.mock.calls[0]?.[0]).toMatchObject({ params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_group' } });
  expect(JSON.stringify(h.cards)).toContain('<at id=ou_owner></at>');
  expect(JSON.stringify(h.cards)).toContain('同意执行'); expect(JSON.stringify(h.cards)).toContain('拒绝');
  await h.approvals.review(h.scope, 'run-1', 'om_question', state()); expect(h.create).toHaveBeenCalledOnce();
  expect(h.resume).not.toHaveBeenCalled();
});
it('only accepts the real owner on the original card and resumes once for duplicate clicks', async () => {
  const h = await setup(); await h.approvals.review(h.scope, 'run', 'om_question', state());
  await h.approvals.action(await h.event('approve', 'ou_member'));
  await h.approvals.action(await h.event('approve', 'ou_owner', 'om_forwarded'));
  await h.approvals.action(await h.event('approve', 'ou_owner', 'om_approval', 'oc_wrong'));
  expect(h.resume).not.toHaveBeenCalled();
  const click = await h.event(); await Promise.all([h.approvals.action(click), h.approvals.action(click)]);
  expect(h.resume).toHaveBeenCalledOnce(); expect(h.send).toHaveBeenCalledOnce();
  const r = await h.approval(); expect(r.status).toBe('resumed');
  expect(h.approvals.grant(h.scope, [r.receiptMessageId], ['ou_member'])?.action).toContain('src/main.ts');
  expect(h.approvals.grant(h.scope, ['om_other'], ['ou_member'])).toBeUndefined();
  expect(h.approvals.grant(h.scope, [r.receiptMessageId], ['ou_intruder'])).toBeUndefined();
  expect(h.approvals.grant('oc_other', [r.receiptMessageId], ['ou_member'])).toBeUndefined();
});
it('posts private-group confirmations in that group and continues only there', async () => {
  const h = await setup(true); await h.approvals.review(h.scope, 'run', 'om_question', state());
  expect(h.create.mock.calls[0]?.[0]).toMatchObject({ params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_privategroup' } });
  await h.approvals.action(await h.event());
  expect(h.send.mock.calls[0]?.[0]).toBe('oc_privategroup');
  const r = await h.approval(); const grant = h.approvals.grant(h.scope, [r.receiptMessageId], ['ou_member'])!;
  const prompt = JSON.parse(await h.auxiliary.wrapPrompt(h.scope, '继续', ['ou_member'], { id: grant.id, action: grant.action, ownerId: grant.ownerId }));
  expect(prompt.context).toMatchObject({ actor: 'member', chat_id: 'oc_privategroup', approval: { action: '修改本机项目源码 src/main.ts' } });
  expect(prompt.rules.permissions).toContain('仅对context.approval.action'); expect(prompt.rules.permissions).toContain('其余操作仍受限');
  expect(prompt).not.toHaveProperty('mode');
});
it('rejects a denial, expired card, changed owner, changed FF or archived private group', async () => {
  const denied = await setup(); await denied.approvals.review(denied.scope, 'run', 'om_question', state());
  await denied.approvals.action(await denied.event('deny')); await denied.approvals.action(await denied.event());
  expect(denied.resume).not.toHaveBeenCalled(); expect((await denied.approval()).status).toBe('denied');
  const expired = await setup(); await expired.approvals.review(expired.scope, 'run', 'om_question', state());
  expired.clock(4_000_000); await expired.approvals.action(await expired.event()); expect((await expired.approval()).status).toBe('expired');
  const native = await setup(); await native.approvals.review(native.scope, 'run', 'om_question', state());
  native.bindings.set(native.scope, { ...native.bindings.get(native.scope)!, nativeId: 'new-ff' });
  await native.approvals.action(await native.event()); expect((await native.approval()).status).toBe('stale'); expect(native.resume).not.toHaveBeenCalled();
  const changed = await setup(); await changed.approvals.review(changed.scope, 'run', 'om_question', state()); changed.owner('ou_new');
  await changed.approvals.action(await changed.event()); expect(changed.resume).not.toHaveBeenCalled();
  const revoked = await setup(true); await revoked.approvals.review(revoked.scope, 'run', 'om_question', state());
  revoked.auxiliary.get(revoked.scope)!.status = 'archived';
  await revoked.approvals.action(await revoked.event()); expect((await revoked.approval()).status).toBe('stale');
});
it('accepts pending callbacks after restart with the same persisted card identity', async () => {
  const h = await setup(); await h.approvals.review(h.scope, 'run', 'om_question', state());
  const restored = new AuxiliaryApprovals(h.deps); await restored.load(); await restored.action(await h.event());
  expect(h.resume).toHaveBeenCalledOnce(); expect(h.create).toHaveBeenCalledOnce();
});
it('retries a known receipt safely after enqueue failure without sending a second receipt', async () => {
  const h = await setup(); await h.approvals.review(h.scope, 'run', 'om_question', state());
  h.resume.mockRejectedValueOnce(new Error('inbox unavailable'));
  await expect(h.approvals.action(await h.event())).rejects.toThrow('inbox unavailable');
  expect((await h.approval()).status).toBe('approved');
  await h.approvals.action(await h.event()); expect(h.send).toHaveBeenCalledOnce(); expect(h.resume).toHaveBeenCalledTimes(2);
  expect((await h.approval()).status).toBe('resumed');
});
it('does not replay an ambiguous continuation send after restart', async () => {
  const h = await setup(); await h.approvals.review(h.scope, 'run', 'om_question', state());
  h.send.mockRejectedValueOnce(new Error('ack lost'));
  await expect(h.approvals.action(await h.event())).rejects.toThrow('ack lost');
  expect((await h.approval()).status).toBe('unknown');
  const restored = new AuxiliaryApprovals(h.deps); await restored.load(); await restored.recover();
  expect(h.resume).not.toHaveBeenCalled(); expect(h.send).toHaveBeenCalledOnce();
});
it('separates an approved continuation from ordinary messages by the same actor', async () => {
  const h = await setup(); await h.approvals.review(h.scope, 'run', 'om_question', state()); await h.approvals.action(await h.event());
  const r = await h.approval();
  const messages = [{ senderId: 'ou_member', messageId: 'ordinary' }, { senderId: 'ou_member', messageId: r.receiptMessageId }, { senderId: 'ou_member', messageId: 'ordinary2' }];
  expect(h.auxiliary.splitRequests(h.scope, messages, m => h.approvals.batchKey(h.scope, m.messageId))).toHaveLength(3);
});
it('parses only explicit complete permission requests, including JSON fences', () => {
  expect(parseApprovalRequest('权限不足')).toBeUndefined(); expect(parseApprovalRequest('{"type":"ff_permission_request"}')).toBeUndefined();
  expect(parseApprovalRequest('先说明进度。\n' + requestText)?.action).toContain('src/main.ts');
  expect(parseApprovalRequest('```json\n' + requestText + '\n```')?.action).toContain('src/main.ts');
});

it.each([false, true])('routes a completed Claude permission response to the correct approval destination (private=%s)', async privateEntry => {
  const h = await setup(privateEntry, 'claude');
  const catalog = new SessionCatalog(join(h.dir, 'catalog')); await catalog.load();
  const sessions = new SessionStore(join(h.dir, 'sessions')); await sessions.load();
  const reply = vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { message_id: 'om_result' } }));
  Object.assign(h.channel.rawClient.im.v1.message, { reply });
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_bot', secret: 's', tenant: 'feishu' } } });
  const job = { id: 'claude-job', status: 'completed', createdAt: 1000, options: { sessionId: '11111111-1111-4111-8111-111111111111', cwd: h.dir,
    delivery: { scope: h.scope, chatId: h.message.chatId, replyTo: 'om_question', operatorOpenId: 'ou_member', botAppId: 'cli_bot', sourceId: h.dir } } };
  const snapshot = { job, events: [{ seq: 1, event: { type: 'text', delta: requestText } }, { seq: 2, event: { type: 'done', terminationReason: 'normal' } }] };
  const publisher = await startWorkerReplies({ adapter: { id: 'claude', client: { sourceId: h.dir, list: async () => [job], snapshot: async () => snapshot } } as any,
    channel: h.channel, controls: { profileConfig: profile, cfg: profile, toolBindings: h.bindings, auxiliary: h.auxiliary, auxiliaryApprovals: h.approvals } as any,
    sessions, catalog, activeRuns: new ActiveRuns(), statePath: join(h.dir, 'replies'), intervalMs: 60_000,
    renderOptions: () => ({ auxiliary: true }) });
  try {
    await publisher.runNow(); expect(h.create.mock.calls[0]?.[0]).toMatchObject({ data: { receive_id: privateEntry ? 'oc_privategroup' : 'oc_group' } });
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ path: { message_id: 'om_question' } });
    expect(h.cards).toHaveLength(2); expect(JSON.stringify(h.cards[1])).not.toContain('ff_permission_request');
    if (privateEntry) expect(JSON.stringify(h.cards[0])).toContain('<at id=ou_owner></at>');
    await h.approvals.action(await h.event()); expect(h.resume).toHaveBeenCalledOnce();
  } finally { await publisher.stop(); await catalog.flush(); await sessions.flush(); }
});
