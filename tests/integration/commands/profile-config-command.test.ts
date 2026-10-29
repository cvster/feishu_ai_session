import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { forgetManagedCard, isManaged, sendManagedCard } from '../../../src/card/managed';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getMessageReplyMode, getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { modelCachePath } from '../../../src/agent/model-cache';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('hides advanced identity/mention/watchdog options without resetting them on submit', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ preferences: { runIdleTimeoutMinutes: 27 } });
    await h.command('/config');
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    for (const field of ['require_mention_in_group', 'lark_cli_identity', 'run_idle_timeout_minutes']) {
      expect(card).not.toContain(field);
    }
    for (const label of ['群里需要 @ bot', 'lark-cli 身份策略', 'run 探活']) expect(card).not.toContain(label);
    await h.command('/config submit', { message_reply: 'text' });
    const root = await waitForRoot(h.rootDir, (candidate) => candidate.profiles.claude?.preferences.messageReply === 'text');
    expect(root.profiles.claude?.preferences.runIdleTimeoutMinutes).toBe(27);
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(true);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
  });
  it.each(['p2p', 'group', 'topic'] as const)('opens settings in %s without recalling or changing the source card', async (chatMode) => {
    const h = await createHarness();
    const source = await sendManagedCard(h.channel as unknown as CommandContext['channel'], 'chat-1', {
      body: { elements: [{ tag: 'markdown', content: 'Original answer / console' }] },
    });
    const send = vi.spyOn(h.channel, 'send');
    const update = vi.spyOn(h.channel, 'updateCardById');
    const recall = vi.fn(async () => {});
    Object.assign(h.channel, { recallMessage: recall });
    await h.command('/config', undefined, { chatMode, messageId: source.messageId, threadId: 'omt_topic' });
    expect(send).toHaveBeenCalledWith('chat-1', expect.anything(), chatMode === 'topic'
      ? { replyTo: source.messageId, replyInThread: true }
      : undefined);
    expect(recall).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(isManaged(source.messageId)).toBe(true);
    const form = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(form).toContain('偏好设置');
    expect(form).toContain('claude-opus-5-5');
    expect(form).not.toContain('claude-fable-5-1');
    expect(form).not.toContain('gpt-6.1-sol');
  });

  it('opens settings from a text command without recalling the command message', async () => {
    const h = await createHarness();
    const recall = vi.fn(async () => {});
    Object.assign(h.channel, { recallMessage: recall });
    await h.command('/config', undefined, { fromCardAction: false, messageId: 'om_config_command' });
    expect(h.channel.sent.at(-1)?.options).toEqual({ replyTo: 'om_config_command' });
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(['submit', 'cancel'])('only updates the new settings form on %s, keeping the CC answer', async (action) => {
    vi.useFakeTimers();
    const h = await createHarness();
    const source = await sendManagedCard(h.channel as unknown as CommandContext['channel'], 'chat-1', {
      body: { elements: [{ tag: 'markdown', content: 'CC answer with settings button' }] },
    });
    const recall = vi.fn(async () => {});
    Object.assign(h.channel, { recallMessage: recall });
    const send = vi.spyOn(h.channel, 'send');
    const update = vi.spyOn(h.channel, 'updateCardById');
    await h.command('/config', undefined, { messageId: source.messageId });
    const form = await send.mock.results[0]!.value;
    const formCardId = (send.mock.calls[0]![1] as { cardId: string }).cardId;
    await h.command(`/config ${action}`, { model: 'claude-opus-5-5' }, { messageId: form.messageId });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(formCardId).not.toBe(source.cardId);
    expect(update).toHaveBeenCalledWith(formCardId, expect.anything(), 1);
    expect(recall).not.toHaveBeenCalled();
    expect(isManaged(source.messageId)).toBe(true);
    expect(isManaged(form.messageId)).toBe(false);
    expect(h.channel.sent[0]?.content).toMatchObject({
      card: { body: { elements: [{ content: 'CC answer with settings button' }] } },
    });
  });

  it('keeps the old console when sending replacement settings fails', async () => {
    const h = await createHarness();
    const recall = vi.fn(async () => {});
    Object.assign(h.channel, { recallMessage: recall });
    vi.spyOn(h.channel, 'createCard').mockRejectedValueOnce(new Error('send failed'));
    await h.command('/config');
    expect(recall).not.toHaveBeenCalled();
  });
  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: false,
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it.each(['claude-opus-4-8', 'claude-opus-5-5'])('persists %s and clears it when "default" is chosen', async (model) => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      model,
      message_reply: 'text',
    });
    const withModel = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === model,
    );
    expect(withModel.profiles.claude?.preferences.model).toBe(model);

    await h.command('/config submit', {
      model: 'default',
      message_reply: 'text',
    });
    const cleared = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === undefined,
    );
    expect(cleared.profiles.claude?.preferences.model).toBeUndefined();
  });

  it('retains a selection absent from cached models when saving unrelated preferences', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ preferences: { model: 'claude-fable-5-1', showToolCalls: false,
      cotMessages: 'brief', maxConcurrentRuns: 7, messageReply: 'text', messageReplyMigrated: true } });
    await h.command('/config');
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('当前选择 · claude-fable-5-1');
    expect(card).toContain('claude-fable-5-1');
    expect(card).toContain('reasoning_effort');
    await h.command('/config submit', { max_concurrent_runs: '8' });
    const root = await waitForRoot(h.rootDir, candidate => candidate.profiles.claude?.preferences.maxConcurrentRuns === 8);
    await vi.advanceTimersByTimeAsync(2000);
    expect(root.profiles.claude?.preferences).toMatchObject({
      showToolCalls: false, cotMessages: 'brief', maxConcurrentRuns: 8, messageReply: 'text',
    });
    expect(root.profiles.claude?.preferences.model).toBe('claude-fable-5-1');
  });

  it('refreshes newly added models and rejects a model deleted while its settings card was open', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    h.nativeModels.push({ value: 'brand-new-native-alias', label: 'Brand new model' });
    await h.command('/config models 0', undefined, { fromCardAction: false });
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('Brand new model');
    h.nativeModels.splice(h.nativeModels.findIndex(row => row.value === 'brand-new-native-alias'), 1);
    await h.command('/config submit', { model: 'brand-new-native-alias', show_tool_calls: 'hide' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('模型列表已变化');
    const root = JSON.parse(await readFile(join(h.rootDir, 'config.json'), 'utf8')) as RootConfig;
    expect(root.profiles.claude?.preferences.model).toBeUndefined();
    expect(root.profiles.claude?.preferences.showToolCalls).not.toBe(false);
  });

  it.each(['p2p', 'group', 'topic'] as const)('refreshes and pages models in the same settings card in %s', async chatMode => {
    const h = await createHarness();
    const send = vi.spyOn(h.channel, 'send');
    const create = vi.spyOn(h.channel, 'createCard');
    const update = vi.spyOn(h.channel, 'updateCardById');
    await h.command('/config', undefined, { chatMode });
    const form = await send.mock.results[0]!.value;
    const cardId = (send.mock.calls[0]![1] as { cardId: string }).cardId;
    for (let index = 0; index < 90; index++) h.nativeModels.push({ value: `new-${index}`, label: `New model ${index}` });
    const draft = { model: 'new-85', reasoning_effort: 'ultra', message_reply: 'text', max_concurrent_runs: '8' };
    await h.command('/config models 1', draft, { chatMode, messageId: form.messageId });
    const refreshed = JSON.stringify(update.mock.calls[0]?.[1]);
    expect(refreshed).toContain('New model 85');
    expect(refreshed).toContain('config.models.1');
    expect(refreshed).toContain('"initial_option":"new-85"');
    expect(refreshed).toContain('"initial_option":"ultra"');
    expect(refreshed).toContain('"initial_option":"text"');
    expect(refreshed).toContain('"default_value":"8"');
    await h.command('/config models 0', draft, { chatMode, messageId: form.messageId });
    expect(send).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update.mock.calls.map(call => [call[0], call[2]])).toEqual([[cardId, 1], [cardId, 2]]);
    expect(isManaged(form.messageId)).toBe(true);
    const root = JSON.parse(await readFile(join(h.rootDir, 'config.json'), 'utf8')) as RootConfig;
    expect(root.profiles.claude?.preferences.model).toBeUndefined();
  });

  it('opens a refreshed settings card when a bridge restart has lost the original card mapping', async () => {
    const h = await createHarness();
    const send = vi.spyOn(h.channel, 'send'), update = vi.spyOn(h.channel, 'updateCardById');
    await h.command('/config', undefined, { chatMode: 'group' });
    const form = await send.mock.results[0]!.value;
    forgetManagedCard(form.messageId);
    h.nativeModels.push({ value: 'new-provider/new-model', label: 'Newly configured model' });
    await h.command('/config models 0', undefined, { chatMode: 'group', messageId: form.messageId });
    expect(update).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('Newly configured model');
  });

  it('rejects a forged reasoning level before saving any preferences', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ preferences: { reasoningEffort: 'medium' } });
    await h.command('/config submit', { reasoning_effort: 'forged-level', max_concurrent_runs: '8' });
    await vi.advanceTimersByTimeAsync(2000);
    const root = JSON.parse(await readFile(join(h.rootDir, 'config.json'), 'utf8')) as RootConfig;
    expect(root.profiles.claude?.preferences.reasoningEffort).toBe('medium');
    expect(root.profiles.claude?.preferences.maxConcurrentRuns).not.toBe(8);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('请选择统一推理档位');
  });

  it('keeps draft settings and stores unified effort even when the model has no native levels', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    h.nativeModels.push({ value: 'future-model', label: 'Future', reasoningEfforts: [{ value: 'future-level', label: 'Future level' }] });
    const send = vi.spyOn(h.channel, 'send');
    await h.command('/config');
    const messageId = (await send.mock.results[0]!.value).messageId;
    const update = vi.spyOn(h.channel, 'updateCardById');
    await h.command('/config preview', { model: 'future-model', reasoning_effort: 'high', message_reply: 'text', max_concurrent_runs: '8' }, { messageId });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const preview = JSON.stringify(update.mock.calls.at(-1)?.[1]);
    expect(preview).not.toContain('future-level'); expect(preview).toContain('"initial_option":"text"');
    expect(preview).toContain('"default_value":"8"');
    const before = JSON.parse(await readFile(join(h.rootDir, 'config.json'), 'utf8')) as RootConfig;
    expect(before.profiles.claude?.preferences.model).toBeUndefined();
    await h.command('/config submit', { model: 'future-model', reasoning_effort: 'ultra', message_reply: 'text' }, { messageId });
    const saved = await waitForRoot(h.rootDir, root => root.profiles.claude?.preferences.model === 'future-model');
    expect(saved.profiles.claude?.preferences.reasoningEffort).toBe('ultra');
    await vi.advanceTimersByTimeAsync(2000);
    h.nativeModels.at(-1)!.reasoningEfforts = [];
    await h.command('/config submit', { model: 'future-model', reasoning_effort: 'ultra', max_concurrent_runs: '10' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).not.toContain('未提供所选推理档位');
    await h.command('/config submit', { model: 'future-model', reasoning_effort: 'default', max_concurrent_runs: '9' });
    const cleared = await waitForRoot(h.rootDir, root => root.profiles.claude?.preferences.maxConcurrentRuns === 9);
    expect(cleared.profiles.claude?.preferences.reasoningEffort).toBe('high');
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('keeps the current message reply mode when the config submit payload omits it', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      preferences: {
        messageReply: 'text',
        messageReplyMigrated: true,
      },
    });

    await h.command('/config submit', {
      show_tool_calls: 'show',
      max_concurrent_runs: '8',
      run_idle_timeout_minutes: '20',
      require_mention_in_group: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.maxConcurrentRuns === 8,
    );
    expect(root.profiles.claude?.preferences.messageReply).toBe('text');
    expect(root.profiles.claude?.preferences.messageReplyMigrated).toBe(true);
    expect(getMessageReplyMode(runtimeProfileConfig(root, 'claude'))).toBe('text');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

type CommandOverrides = Partial<Pick<CommandContext, 'chatMode' | 'fromCardAction'>> & {
  messageId?: string;
  threadId?: string;
};

async function createHarness(options: {
  preferences?: RootConfig['profiles'][string]['preferences'];
} = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  nativeModels: Array<import('../../../src/agent/models').ModelOption>;
  agent: FakeAgentAdapter & { listModels: ReturnType<typeof vi.fn> };
  command(content: string, formValue?: Record<string, unknown>, overrides?: CommandOverrides): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options.preferences);
  const profileConfig = root.profiles.claude!;
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  const nativeModels = ['default', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5'].map(value => ({ value, label: value, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value })) }));
  const agent = Object.assign(new FakeAgentAdapter(), { listModels: vi.fn(async () => nativeModels) });
  // Production warms the persistent catalogue before settings are opened.
  await writeJson(modelCachePath(appPaths.profileDir, profileConfig.accounts.app.id, agent.id), { version: 1, options: nativeModels });
  return {
    rootDir,
    channel, nativeModels, agent,
    command: (content: string, formValue?: Record<string, unknown>, overrides: CommandOverrides = {}) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: {
          ...message(content),
          ...(overrides.messageId ? { messageId: overrides.messageId } : {}),
          ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
        },
        scope: 'chat-1',
        chatMode: overrides.chatMode ?? 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: overrides.fromCardAction ?? true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles.claude!.workspaces.default = workspace;
  root.profiles.claude!.preferences = {
    ...root.profiles.claude!.preferences,
    ...preferences,
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
