import { NativeSessionLocks } from '../../../src/tools/locks';
import { sessionRefKey } from '../../../src/tools/bindings';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LarkChannel } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { AgentKind } from '../../../src/config/profile-schema';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types';
import { ToolRegistry } from '../../../src/tools/types';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { controlsForTool, routeCommandContext } from '../../../src/tools/context';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { startRunFlow } from '../../../src/bot/run-flow';
import { claudeCapability } from '../../../src/agent/capability';
import { syncAaSessionGroupsOnce } from '../../../src/bot/aa-session-groups';
import { runCommandHandler, type Controls, type CommandContext } from '../../../src/commands';
import { copiedSessionCard } from '../../../src/card/templates';

const clean: string[] = [];
const flushes: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(flushes.splice(0).map(f => f())); await Promise.all(clean.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'personal-tools-')); clean.push(dir);
  const groups: { id: string; name: string }[] = [];
  const runs: { toolId: AgentKind; options: AgentRunOptions }[] = [];
  const channel = { listChats: async () => [...groups], rawClient: { im: { v1: { chat: {
    create: async ({ data }: { data: { name: string } }) => {
      const id = `oc_group_${groups.length + 1}`; groups.push({ id, name: data.name }); return { code: 0, data: { chat_id: id } };
    },
  } } } }, createCard: vi.fn(async () => ({ cardId: 'card' })), send: vi.fn(async () => ({ messageId: 'msg' })) } as unknown as LarkChannel;
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_app', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', inheritCodexHome: true }, workspaces: undefined,
    access: { allowedChats: ['*'], allowedUsers: ['ou_owner'] } } as Parameters<typeof createDefaultProfileConfig>[0]);
  profile.workspaces.default = dir; profile.preferences.model = 'gpt-6.1-sol';
  const registry = new ToolRegistry();
  for (const toolId of ['codex', 'claude'] as const) {
    const agent = { id: toolId, displayName: toolId, isAvailable: async () => true,
      run: (options: AgentRunOptions) => { runs.push({ toolId, options }); return { runId: options.runId,
        events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const, terminationReason: 'normal' as const }; } },
        stop: async () => {}, waitForExit: async () => true }; },
    } as AgentAdapter;
    registry.register({ id: toolId, sourceId: `${toolId}-home`, label: toolId, agent,
      listSessions: async () => [{ nativeId: 'same-uuid', name: 'AA-同名', cwd: dir, createdAtMs: 1, updatedAtMs: 2 }] });
  }
  const bindings = new ToolBindingStore(join(dir, 'tools.json')); await bindings.load();
  const catalog = new SessionCatalog(join(dir, 'catalog.json')); await catalog.load();
  const sessions = new SessionStore(join(dir, 'sessions.json')); await sessions.load();
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json')); await workspaces.load();
  flushes.push(() => Promise.all([bindings.flush(), catalog.flush(), sessions.flush(), workspaces.flush()]));
  const activeRuns = new ActiveRuns(); const pool = new ProcessPool(() => 2);
  const executors = new Map<AgentKind, RunExecutor>();
  const nativeSessionLocks = new NativeSessionLocks();
  for (const tool of registry.all()) executors.set(tool.id, new RunExecutor({ agent: tool.agent, activeRuns, pool,
    nativeSessionLocks, nativeSessionKey: id => sessionRefKey(tool.id, tool.sourceId, id),
    sessionNameForScope: scope => bindings.get(scope)?.name,
    initialSessionIdForScope: scope => bindings.get(scope)?.nativeCreated === false ? bindings.get(scope)?.nativeId : undefined }));
  const controls = { profile: 'codex', profileConfig: profile, cfg: { accounts: profile.accounts, preferences: profile.preferences },
    botOwnerId: 'ou_owner', ownerRefreshState: 'ok', configPath: join(dir, 'config.json'), defaultToolId: 'codex',
    toolRegistry: registry, toolBindings: bindings, executorForTool: (id: AgentKind) => executors.get(id),
    knownChats: [], refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  } as unknown as Controls;
  function context(scope = 'dm', chatType: 'p2p' | 'group' = 'p2p'): CommandContext {
    return { channel, scope, chatMode: chatType === 'p2p' ? 'p2p' : 'group',
      msg: { chatId: scope, messageId: 'msg', chatType, senderId: 'ou_owner', senderName: 'owner', content: '',
        rawContentType: 'text', resources: [], mentions: [], mentionedBot: true, mentionAll: false, createTime: 1 },
      agent: registry.get('codex').agent, sessions, sessionCatalog: catalog, workspaces, activeRuns, processPool: pool,
      controls, dmGroupCreationOnly: true, runExecutor: executors.get('codex') };
  }
  const sync = () => syncAaSessionGroupsOnce({ channel, controls, sessionCatalog: catalog, workspaces, profileStateDir: dir });
  return { dir, groups, runs, registry, bindings, catalog, sessions, workspaces, controls, context, sync, channel };
}

describe('personal multi-tool workflows', () => {
  function copyElements(h: Awaited<ReturnType<typeof harness>>) {
    const card = vi.mocked(h.channel.createCard).mock.calls.at(-1)![0] as any;
    const flatten = (row: any): any[] => [row, ...(row.elements ?? row.columns ?? []).flatMap(flatten)];
    return flatten(card.body);
  }
  function copyButton(h: Awaited<ReturnType<typeof harness>>, label: string, command = 'fork.to') {
    return copyElements(h).find((b: any) => b.text?.content === label && b.behaviors?.[0]?.value?.cmd === command)?.behaviors[0].value;
  }
  it('labels the copy and create rows and includes the current tool in both', async () => {
    const h = await harness(); await h.sync();
    for (const id of ['zcode', 'kilo', 'dsh'] as const) h.registry.register({ id, sourceId: id+'-home', label: id,
      agent: { ...h.registry.get('claude').agent, id, isAvailable: async () => id === 'dsh' ? Promise.reject(Error('offline')) : id === 'kilo' }, listSessions: async () => [] });
    await runCommandHandler('fork', '', h.context(h.groups[0]!.id, 'group'));
    expect(copyButton(h, 'Codex', 'fork.same')).toMatchObject({ cmd: 'fork.same' });
    expect(copyButton(h, 'Claude')).toMatchObject({ cmd: 'fork.to' });
    expect(copyButton(h, 'Kilo')).toMatchObject({ cmd: 'fork.to' });
    expect(copyButton(h, 'Codex')).toMatchObject({ cmd: 'fork.to' });
    expect(copyButton(h, 'Codex').arg).not.toBe(copyButton(h, 'Codex', 'fork.same').arg);
    expect(copyButton(h, 'Zcode')).toBeUndefined(); expect(copyButton(h, 'Dsh')).toBeUndefined();
    const elements = copyElements(h);
    expect(elements.filter(row => row.tag === 'column_set').map(row => row.columns[0].elements[0].content)).toEqual(['复制会话：', '在新工具中创建会话：']);
    expect(elements.find(row => row.tag === 'input')).toMatchObject({ name: 'new_session_name', default_value: 'AA-同名-2', required: true });
    expect(elements.filter(row => row.tag === 'button').every(row => row.form_action_type === 'submit' && row.name)).toBe(true);
    expect(h.groups).toHaveLength(2);
  });
  it('creates a fresh session in the original tool from the second row without forking or copying history automatically', async () => {
    const h = await harness(); h.controls.profileConfig.preferences.reasoningEffort = 'high';
    await h.sync(); const source = h.groups[0]!.id;
    const fork = vi.fn(async () => { throw Error('must not call native fork'); }); h.registry.get('codex').agent.forkThread = fork;
    const before = h.bindings.get(source);
    await runCommandHandler('fork', '', h.context(source, 'group'));
    const value = copyButton(h, 'Codex');
    await runCommandHandler('fork', `to ${value.arg}`, h.context(source, 'group'));
    expect(h.groups).toHaveLength(3); const target = h.groups[2]!.id;
    expect(h.groups[2]!.name).toBe('AA-同名-2');
    expect(h.workspaces.cwdFor(target)).toBe(h.dir);
    expect(h.bindings.get(target)).toMatchObject({ toolId: 'codex', nativeCreated: false, reasoningEffort: 'high', copiedFrom: { toolId: 'codex', nativeId: 'same-uuid' } });
    expect(h.bindings.get(target)?.nativeId).not.toBe('same-uuid');
    expect(h.bindings.get(source)).toEqual(before); expect(fork).not.toHaveBeenCalled(); expect(h.runs).toEqual([]);
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).toContain('读取原会话内容');
  });
  it.each([
    ['AA-同名', [], 'AA-同名-2'],
    ['AA-同名-2', [], 'AA-同名-3'],
    ['AA-同名-9', ['AA-同名-10', 'AA-同名-11'], 'AA-同名-12'],
    ['AA-同名-v2', ['AA-同名-v2-2'], 'AA-同名-v2-3'],
  ] as const)('suggests the next unused suffix for %s and reuses it for submissions without form values', async (sourceName, taken, expected) => {
    const h = await harness(); await h.sync(); const source = h.groups[0]!.id;
    h.bindings.set(source, { ...h.bindings.get(source)!, name: sourceName });
    vi.spyOn(h.registry.get('claude'), 'listSessions').mockResolvedValue(taken.map((name, i) => ({ nativeId: 'unbound-' + i, name, cwd: h.dir, createdAtMs: 1, updatedAtMs: 2 })));
    await runCommandHandler('fork', '', h.context(source, 'group'));
    expect(copyElements(h).find(row => row.tag === 'input')?.default_value).toBe(expected);
    const value = copyButton(h, 'Claude');
    await runCommandHandler('fork', `to ${value.arg}`, h.context(source, 'group'));
    expect(h.groups.at(-1)?.name).toBe(expected);
  });
  it('skips names held by pending group bindings when native session listings fail', async () => {
    const h = await harness(); await h.sync(); const source = h.groups[0]!.id;
    h.bindings.set(source, { ...h.bindings.get(source)!, name: 'AA-同名-2' });
    h.bindings.set('oc_pending', { toolId: 'claude', sourceId: 'claude-home', nativeId: 'pending', nativeCreated: false, name: 'AA-同名-3' });
    vi.spyOn(h.registry.get('claude'), 'listSessions').mockRejectedValue(Error('listing unavailable'));
    await runCommandHandler('fork', '', h.context(source, 'group'));
    expect(copyElements(h).find(row => row.tag === 'input')?.default_value).toBe('AA-同名-4');
  });
  it.each(['claude', 'kilo'] as const)('creates a fresh %s cross-tool group with default model and high reasoning and only imports history on click after restart', async targetTool => {
    const h = await harness(); h.controls.profileConfig.preferences.reasoningEffort = 'high';
    if (targetTool === 'kilo') h.registry.register({ id: 'kilo', sourceId: 'kilo-home', label: 'Kilo',
      agent: { ...h.registry.get('claude').agent, id: 'kilo' }, listSessions: async () => [] });
    await h.sync();
    const source = h.groups[0]!.id; const before = h.bindings.get(source);
    await runCommandHandler('fork', '', h.context(source, 'group'));
    const value = copyButton(h, targetTool === 'kilo' ? 'Kilo' : 'Claude');
    const creation = h.context(source, 'group'); creation.formValue = { new_session_name: '  AA-自定义会话  ' };
    await runCommandHandler('fork', `to ${value.arg}`, creation);
    expect(h.groups).toHaveLength(3); const target = h.groups[2]!.id;
    expect(h.groups[2]!.name).toBe('AA-自定义会话');
    expect(h.workspaces.cwdFor(target)).toBe(h.dir);
    expect(h.bindings.get(target)).toMatchObject({ toolId: targetTool, name: 'AA-自定义会话', nativeCreated: false, model: 'default', reasoningEffort: 'high',
      copiedFrom: { toolId: 'codex', sourceId: 'codex-home', nativeId: 'same-uuid', name: 'AA-同名', cwd: h.dir } });
    expect(controlsForTool(h.controls, targetTool, target).profileConfig.preferences.reasoningEffort).toBe('high');
    expect(h.bindings.get(source)).toEqual(before); expect(h.runs).toEqual([]);
    const provenance = h.bindings.get(target)!.copiedFrom!;
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).toContain('当前会话从“Codex”复制');
    expect(JSON.stringify(copiedSessionCard(provenance))).toContain('fork.read');
    const restored = new ToolBindingStore(join(h.dir, 'tools.json')); await restored.load(); h.controls.toolBindings = restored;
    const history = join(h.dir, 'latest-history.json'); await writeFile(history, 'latest source content');
    const historyPath = vi.fn(async () => history);
    h.registry.get('codex').sessions = { historyPath, rename: async () => {}, archive: async () => {} };
    const submit = vi.fn(async (_message: CommandContext['msg']) => {}); h.controls.submitMessage = submit;
    const ctx = h.context(target, 'group'); ctx.fromCardAction = true;
    await runCommandHandler('fork', `read ${provenance.copyId}`, ctx);
    expect(historyPath).toHaveBeenCalledWith('same-uuid');
    expect(h.channel.send).toHaveBeenLastCalledWith(target, { text: submit.mock.calls[0]![0].content }, { replyTo: 'msg' });
    expect(vi.mocked(h.channel.send).mock.invocationCallOrder.at(-1)).toBeLessThan(submit.mock.invocationCallOrder[0]!);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ chatId: target, messageId: 'msg', chatType: 'group', senderId: 'ou_owner', mentionedBot: true,
      content: `读取codex '${h.dir.split('/').at(-1)}/AA-同名' 的内容\n会话记录：${history}`, raw: { bridgeCallbackId: `copy-read-${provenance.copyId}` } }));
    await runCommandHandler('fork', `to ${value.arg}`, h.context(source, 'group')); expect(h.groups).toHaveLength(3);
  });
  it('offers same-tool creation with a read button when the original tool has no native fork', async () => {
    const h = await harness(); await h.sync(); const group = h.groups[1]!.id;
    await runCommandHandler('fork', '', h.context(group, 'group'));
    const value = copyButton(h, 'Claude', 'fork.same');
    await runCommandHandler('fork', `same ${value.arg}`, h.context(group, 'group'));
    expect(h.groups).toHaveLength(3); expect(h.bindings.get(h.groups[2]!.id)).toMatchObject({ toolId: 'claude', nativeCreated: false, copiedFrom: { toolId: 'claude' } });
    expect(h.groups[2]!.name).toBe('AA-同名（Claude）-2');
  });
  it.each(['', '   ', 'x'.repeat(101), 'name\ninvalid', 42])('rejects invalid new names before native copy or fresh creation: %s', async name => {
    const h = await harness(); await h.sync(); const group = h.groups[0]!.id;
    const fork = vi.fn(); h.registry.get('codex').agent.forkThread = fork;
    await runCommandHandler('fork', '', h.context(group, 'group'));
    const values = [copyButton(h, 'Codex', 'fork.same'), copyButton(h, 'Claude')];
    for (const value of values) {
      const ctx = h.context(group, 'group'); ctx.formValue = { new_session_name: name };
      await runCommandHandler('fork', `${value.cmd.split('.')[1]} ${value.arg}`, ctx);
    }
    expect(h.groups).toHaveLength(2); expect(fork).not.toHaveBeenCalled();
  });
  it('retries naming and group creation with the same native copy and keeps the scanner paused', async () => {
    const h = await harness(); await h.sync(); const group = h.groups[0]!.id;
    let paused = false;
    h.controls.withAaSessionGroupSyncPaused = async operation => { paused = true; try { return await operation(); } finally { paused = false; } };
    const fork = vi.fn(async () => { expect(paused).toBe(true); return { nativeId: 'copy-retry', name: 'native default', cwd: h.dir }; });
    const rename = vi.fn(async () => { expect(paused).toBe(true); }).mockRejectedValueOnce(Error('rename temporarily unavailable'));
    h.registry.get('codex').sessions = { fork, rename, archive: async () => {}, historyPath: async () => undefined };
    await runCommandHandler('fork', '', h.context(group, 'group')); const value = copyButton(h, 'Codex', 'fork.same');
    const ctx = h.context(group, 'group'); ctx.formValue = { new_session_name: 'AA-重试副本' };
    await runCommandHandler('fork', `same ${value.arg}`, ctx);
    expect(h.groups).toHaveLength(2); expect(fork).toHaveBeenCalledOnce();
    vi.spyOn(h.channel.rawClient.im.v1.chat, 'create').mockRejectedValueOnce(Error('group temporarily unavailable'));
    await runCommandHandler('fork', `same ${value.arg}`, ctx);
    expect(h.groups).toHaveLength(2);
    await runCommandHandler('fork', `same ${value.arg}`, ctx);
    await runCommandHandler('fork', `same ${value.arg}`, ctx);
    expect(fork).toHaveBeenCalledOnce(); expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith('copy-retry', 'AA-重试副本');
    expect(h.groups[2]?.name).toBe('AA-重试副本');
    expect(h.bindings.get(group)).toMatchObject({ nativeId: 'same-uuid', name: 'AA-同名' });
    expect(paused).toBe(false);
  });
  it('rejects a forwarded copy choice, changed source binding, and an alternative that became unavailable', async () => {
    const h = await harness(); await h.sync(); const group = h.groups[0]!.id;
    await runCommandHandler('fork', '', h.context(group, 'group')); const value = copyButton(h, 'Claude');
    const stranger = h.context(group, 'group'); stranger.msg.senderId = 'ou_other';
    await runCommandHandler('fork', `to ${value.arg}`, stranger); expect(h.groups).toHaveLength(2);
    h.registry.get('claude').agent.isAvailable = async () => false;
    await runCommandHandler('fork', `to ${value.arg}`, h.context(group, 'group')); expect(h.groups).toHaveLength(2);
    h.bindings.set(group, { ...h.bindings.get(group)!, nativeId: 'changed-session', name: 'changed' });
    h.catalog.archiveScope(group, 'changed');
    await runCommandHandler('fork', `to ${value.arg}`, h.context(group, 'group')); expect(h.groups).toHaveLength(2); await h.bindings.flush();
  });
  it('does not submit a history read when the persisted source account changes or history is unavailable', async () => {
    const h = await harness(); await h.sync(); const group = h.groups[0]!.id;
    await runCommandHandler('fork', '', h.context(group, 'group')); const value = copyButton(h, 'Claude');
    await runCommandHandler('fork', `to ${value.arg}`, h.context(group, 'group'));
    const target = h.groups[2]!.id; const source = h.bindings.get(target)!.copiedFrom!;
    const submit = vi.fn(async (_message: CommandContext['msg']) => {}); h.controls.submitMessage = submit;
    const ctx = h.context(target, 'group'); ctx.fromCardAction = true;
    h.registry.get('codex').sourceId = 'another-account';
    await runCommandHandler('fork', `read ${source.copyId}`, ctx); expect(submit).not.toHaveBeenCalled();
    h.registry.get('codex').sourceId = source.sourceId;
    h.registry.get('codex').sessions = { historyPath: async () => undefined, rename: async () => {}, archive: async () => {} };
    await runCommandHandler('fork', `read ${source.copyId}`, ctx); expect(submit).not.toHaveBeenCalled();
    await runCommandHandler('fork', 'read forged-copy', ctx); expect(submit).not.toHaveBeenCalled();
  });
  it('archives a pending Claude reservation before its first init event and stops a recovered worker task', async () => {
    const h = await harness(); h.registry.get('claude').reserveSessionId = () => 'same-uuid';
    const stopScope = vi.fn(async () => true);
    h.controls.workerRuntimes = new Map([['claude', { inbox: {} as any, replies: { runNow: async () => {}, stopScope } }]]);
    const creation = h.context(); creation.formValue = { group_name: 'AA-pending', cwd: h.dir, agent_kind: 'claude' };
    await runCommandHandler('new', 'chat form', creation);
    const group = h.groups[0]!.id;
    expect(h.catalog.entries()).toHaveLength(0);
    await runCommandHandler('finish', 'archive', h.context(group, 'group'));
    expect(stopScope).toHaveBeenCalledWith(group);
    expect(h.catalog.isScopeArchived(group)).toBe(true);
    expect(h.bindings.isArchived('claude', 'claude-home', 'same-uuid')).toBe(true);
    await h.sync(); expect(h.groups).toHaveLength(2); // pending Claude group and the separate Codex AA source
  });
  it('imports same name and UUID from both tools, stays idempotent, and resumes Claude with its original ID and cwd', async () => {
    const h = await harness(); await h.sync(); await h.sync();
    expect(h.groups).toHaveLength(2);
    expect(h.groups.map(g => g.name)).toEqual(['AA-同名', 'AA-同名（Claude）']);
    expect(h.catalog.entries().filter(e => e.status === 'active').map(e => [e.agentId, e.threadId ?? e.sessionId]))
      .toEqual([['codex', 'same-uuid'], ['claude', 'same-uuid']]);
    const ctx = await routeCommandContext(h.context(h.groups[1]!.id, 'group'));
    expect(ctx.agent.id).toBe('claude'); expect(ctx.controls.codexSubmissions).toBeUndefined();
    expect(ctx.controls.profileConfig.preferences.model).toBeUndefined();
    const flow = await startRunFlow({ scopeId: ctx.scope, scope: { source: 'im', chatId: ctx.scope, actorId: 'ou_owner' },
      prompt: 'continue', attachments: [], access: { ok: true, reason: 'owner' }, capability: claudeCapability(ctx.controls.profileConfig),
      profileConfig: ctx.controls.profileConfig, sessions: h.sessions, sessionCatalog: h.catalog, workspaces: h.workspaces,
      executor: ctx.runExecutor!, now: Date.now() });
    expect(flow.ok).toBe(true);
    if (flow.ok) for await (const _ of flow.execution.subscribe()) { /* release */ }
    expect(h.runs[0]).toMatchObject({ toolId: 'claude', options: { sessionId: 'same-uuid', cwd: h.dir } });
    expect(h.controls.profileConfig.agentKind).toBe('codex');
    expect(h.controls.profileConfig.preferences.model).toBe('gpt-6.1-sol');
  });
  it('archives Claude without closing a same-ID Codex session or recreating the Claude group', async () => {
    const h = await harness(); await h.sync();
    const claudeGroup = h.groups[1]!;
    await runCommandHandler('finish', 'archive', h.context(claudeGroup.id, 'group'));
    expect(h.catalog.isScopeArchived(claudeGroup.id)).toBe(true);
    expect(h.catalog.isThreadArchived('same-uuid')).toBe(false);
    expect(h.bindings.isArchived('claude', 'claude-home', 'same-uuid')).toBe(true);
    await h.sync(); expect(h.groups).toHaveLength(2);
  });
  it('saves tool choice only on the created group and defaults legacy creation to Codex', async () => {
    const h = await harness(); const first = h.context();
    first.formValue = { group_name: 'Claude task', cwd: h.dir, agent_kind: 'claude' };
    await runCommandHandler('new', 'chat form', first);
    expect(h.bindings.get(h.groups[0]!.id)?.toolId).toBe('claude');
    expect(h.controls.profileConfig.agentKind).toBe('codex');
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).toContain('Claude');
    await runCommandHandler('new', 'chat Codex task', h.context());
    expect(h.bindings.get(h.groups[1]!.id)?.toolId).toBe('codex');
    expect(() => h.bindings.set(h.groups[0]!.id, { toolId: 'codex', sourceId: 'codex-home' })).toThrow('不能切换');
  });
  it('does not create a group when the selected tool is unavailable', async () => {
    const h = await harness(); h.registry.get('claude').agent.isAvailable = async () => false;
    const ctx = h.context(); ctx.formValue = { group_name: 'unavailable', cwd: h.dir, agent_kind: 'claude' };
    await runCommandHandler('new', 'chat form', ctx); expect(h.groups).toEqual([]);
  });
  it('continues another provider when discovery fails and rejects a changed session source', async () => {
    const h = await harness(); h.registry.get('codex').listSessions = async () => { throw Error('offline'); };
    await h.sync(); expect(h.groups).toHaveLength(1);
    h.registry.get('claude').sourceId = 'other-account';
    await expect(routeCommandContext(h.context(h.groups[0]!.id, 'group'))).rejects.toThrow('数据来源已变化');
  });
  it('scoped control views do not poison the global profile when updated', async () => {
    const h = await harness(); const view = controlsForTool(h.controls, 'claude');
    expect(view.profileConfig.agentKind).toBe('claude');
    view.profileConfig = { ...h.controls.profileConfig, preferences: { ...h.controls.profileConfig.preferences, showToolCalls: true } };
    expect(h.controls.profileConfig.agentKind).toBe('codex');
    expect(view.profileConfig.agentKind).toBe('claude');
    expect(h.controls.profileConfig.preferences.showToolCalls).toBe(true);
  });
  it('does not re-import a named Claude session while its first response is still pending', async () => {
    const h = await harness(); h.registry.get('claude').reserveSessionId = () => 'same-uuid';
    const ctx = h.context(); ctx.formValue = { group_name: 'AA-同名', cwd: h.dir, agent_kind: 'claude' };
    await runCommandHandler('new', 'chat form', ctx);
    expect(h.bindings.get(h.groups[0]!.id)).toMatchObject({ toolId: 'claude', nativeId: 'same-uuid', nativeCreated: false });
    await h.sync(); await h.sync();
    expect(h.groups).toHaveLength(2); // original Claude group and the distinct Codex source
    expect(h.catalog.entries().filter(e => e.agentId === 'claude')).toEqual([]);
    const routed = await routeCommandContext(h.context(h.groups[0]!.id, 'group'));
    const flow = await startRunFlow({ scopeId: routed.scope, scope: { source: 'im', chatId: routed.scope, actorId: 'ou_owner' },
      prompt: 'first task', attachments: [], access: { ok: true, reason: 'owner' }, capability: claudeCapability(routed.controls.profileConfig),
      profileConfig: routed.controls.profileConfig, sessions: h.sessions, sessionCatalog: h.catalog, workspaces: h.workspaces,
      executor: routed.runExecutor!, now: Date.now() });
    if (flow.ok) for await (const _ of flow.execution.subscribe()) { /* complete */ }
    expect(h.runs[0]?.options).toMatchObject({ initialSessionId: 'same-uuid', sessionName: 'AA-同名' });
    expect(h.runs[0]?.options.sessionId).toBeUndefined();
  });

});
