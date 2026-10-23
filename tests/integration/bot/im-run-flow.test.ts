import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityForTool, claudeCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { RunRejected } from '../../../src/runtime/errors';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('resumes a CC binding with a newly advertised model and the selected effort', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    h.profileConfig.preferences.model = 'provider-new-model';
    Object.assign(h.agent, { listModels: async () => [{ value: 'provider-new-model', label: 'new native model', reasoningEfforts: [{ value: 'xhigh', label: 'xhigh' }] }] });
    h.profileConfig.preferences.reasoningEffort = 'xhigh';
    h.sessions.set('chat-1', 'existing-cc-session', await realpath(h.tmp.workspace));
    const result = await startRunFlow({ scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' }, prompt: 'continue', attachments: [],
      access: { ok: true, reason: 'allowed-user' }, capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig, sessions: h.sessions, workspaces: h.workspaces,
      executor: h.executor, now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({ sessionId: 'existing-cc-session', reasoningEffort: 'xhigh' });
    expect(h.agent.runOptions[0]?.model).toBe('provider-new-model');
  });

  it.each(['claude', 'codex', 'zcode'] as const)('rejects a removed %s model before starting a task', async kind => {
    const h = await createHarness({ defaultWorkspace: true });
    h.profileConfig.agentKind = kind; h.profileConfig.preferences.model = 'removed-model';
    Object.assign(h.agent, { listModels: async () => [{ value: 'new-model', label: 'New model' }] });
    const result = await startRunFlow({ scopeId: 'chat-1', scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'must not run', attachments: [], access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForTool(kind, h.profileConfig), profileConfig: h.profileConfig, sessions: h.sessions, workspaces: h.workspaces,
      executor: h.executor, now: 1000 });
    expect(result).toMatchObject({ ok: false, rejectReason: { code: 'model-unavailable', userVisible: expect.stringContaining('/config') } });
    expect(h.agent.runOptions).toEqual([]);
  });

  it.each(['claude', 'codex', 'zcode'] as const)('rejects stale %s reasoning levels before spawning, and follows native default when requested', async kind => {
    const h = await createHarness({ defaultWorkspace: true });
    h.profileConfig.agentKind = kind; h.profileConfig.preferences.model = 'model';
    h.profileConfig.preferences.reasoningEffort = 'deleted-level';
    Object.assign(h.agent, { listModels: async () => [{ value: 'model', label: 'Model', reasoningEfforts: [{ value: 'new-level', label: 'New' }] }] });
    const input = { scopeId: 'chat-1', scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello', attachments: [], access: { ok: true as const, reason: 'allowed-user' as const },
      capability: capabilityForTool(kind, h.profileConfig), profileConfig: h.profileConfig, sessions: h.sessions, workspaces: h.workspaces, executor: h.executor, now: 1000 };
    expect(await startRunFlow(input)).toMatchObject({ ok: false, rejectReason: { code: 'model-unavailable' } });
    expect(h.agent.runOptions).toEqual([]);
    h.profileConfig.preferences.reasoningEffort = 'default';
    expect(await startRunFlow(input)).toMatchObject({ ok: true });
    expect(h.agent.runOptions[0]?.reasoningEffort).toBeUndefined();
  });

  it.each(['persisted', 'external', 'unavailable'])('does not submit or create a session after archive: %s', async (mode) => {
    const h = await createHarness({ defaultWorkspace: true });
    const catalog = new SessionCatalog(join(h.tmp.profile, 'catalog.json'));
    if (mode === 'persisted') {
      catalog.upsertActive({ scopeId: 'chat-1', agentId: 'codex', cwdRealpath: h.tmp.workspace, policyFingerprint: 'p', threadId: 'old' });
      catalog.archiveCodexThread('old');
    }
    const result = await startRunFlow({ scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' }, prompt: '继续', attachments: [],
      access: { ok: true, reason: 'allowed-user' }, capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig, sessions: h.sessions, sessionCatalog: catalog,
      workspaces: h.workspaces, executor: h.executor, now: 1000,
      checkSessionArchived: async () => { if (mode === 'unavailable') throw new Error('offline'); return mode === 'external'; },
    });
    expect(result).toMatchObject({ ok: false, rejectReason: {
      code: mode === 'unavailable' ? 'archive-check-unavailable' : 'session-archived',
      userVisible: mode === 'unavailable' ? '暂时无法确认会话归档状态，请稍后重试。' : '会话已归档。请通过控制台手动绑定未归档的会话。',
      ...(mode === 'unavailable' ? { retryable: true } : {}),
    } });
    expect(h.agent.runOptions).toEqual([]);
    await catalog.flush();
  });

  it.each(['initial', 'before-spawn'] as const)('marks a temporary archive lookup failure retryable at %s', async phase => {
    const h = await createHarness({ defaultWorkspace: true }); let checks = 0;
    const input = { scopeId: 'chat-1', scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'continue', attachments: [], access: { ok: true as const, reason: 'allowed-user' as const },
      capability: claudeCapability(h.profileConfig), profileConfig: h.profileConfig,
      sessions: h.sessions, workspaces: h.workspaces, executor: h.executor, now: 1000,
      checkSessionArchived: async () => { if (phase === 'initial' || ++checks > 1) throw new Error('worker offline'); return false; } };
    expect(await startRunFlow(input)).toMatchObject({ ok: false, rejectReason: { code: 'archive-check-unavailable', retryable: true } });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('keeps permanent binding failures non-retryable', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    expect(await startRunFlow({ scopeId: 'chat-1', scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'continue', attachments: [], access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig), profileConfig: h.profileConfig, sessions: h.sessions,
      workspaces: h.workspaces, executor: h.executor, now: 1000,
      checkSessionArchived: async () => { throw new RunRejected('archive-check-unavailable', 'wrong account'); },
    })).toMatchObject({ ok: false, rejectReason: { retryable: false } });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('rechecks archival after the initial lookup and before any task spawn', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const catalog = new SessionCatalog(join(h.tmp.profile, 'catalog.json'));
    catalog.upsertActive({ scopeId: 'chat-1', agentId: 'codex', cwdRealpath: h.tmp.workspace, policyFingerprint: 'p', threadId: 'old' });
    const result = await startRunFlow({ scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' }, prompt: '继续', attachments: [],
      access: { ok: true, reason: 'allowed-user' }, capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig, sessions: h.sessions, sessionCatalog: catalog,
      workspaces: h.workspaces, executor: h.executor, now: 1000,
      checkSessionArchived: async () => { catalog.archiveCodexThread('old'); return false; },
    });
    expect(result).toMatchObject({ ok: false, rejectReason: { code: 'session-archived' } });
    expect(h.agent.runOptions).toEqual([]); await catalog.flush();
  });
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

});

async function createHarness(options: { defaultWorkspace?: boolean } = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
      },
    },
  };
}
