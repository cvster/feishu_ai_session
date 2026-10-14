import { NativeSessionLocks } from '../../../src/tools/locks';
import { sessionRefKey } from '../../../src/tools/bindings';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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

const clean: string[] = [];
afterEach(async () => { await Promise.all(clean.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
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
    codexSubmissions: {}, knownChats: [], refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
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
  it('imports same name and UUID from both tools, stays idempotent, and resumes Claude with its original ID and cwd', async () => {
    const h = await harness(); await h.sync(); await h.sync();
    expect(h.groups).toHaveLength(2);
    expect(h.groups.map(g => g.name)).toEqual(['AA-同名', 'AA-同名（Claude Code）']);
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
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).toContain('Claude Code');
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
