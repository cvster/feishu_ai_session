import { nativeSessionFields, nativeSessionId } from '../tools/definitions';
import { isToolId, toolDefinition, type ToolId } from '../tools/definitions';
import { controlsForTool, routeCommandContext } from '../tools/context';
import type { ToolRegistry } from '../tools/types';
import { isPersonalWorkgroup, PersonalBindingConflict, type ToolBindingStore } from '../tools/bindings';
import type { CopiedSessionSource } from '../tools/bindings';
import { currentCopySource, readCopiedSession, sessionCopyChoice, showSessionCopyMenu } from './session-copy';
import { DurableAgentAdapter } from '../worker/adapter';
import { randomUUID } from 'node:crypto';
import { cachedModelChoices, modelCachePath } from '../agent/model-cache';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { capabilityForTool } from '../agent/capability';
import { DEFAULT_MODEL, loadModelChoices, normalizeModelSelection, normalizeReasoningEffort,
  DEFAULT_REASONING, UNIFIED_REASONING, resolveReasoningEffort } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, isManaged, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  existingSessionsCard,
  finishTaskConfirmationCard,
  helpCard,
  managedGroupDetailCard,
  managedGroupsCard,
  newChatCreationCard,
  newChatWorkspaceCard,
  newSessionConfirmationCard,
  panelConfirmationCard,
  resumeCard,
  statusCard,
  taskPanelCard,
  type ExistingSessionCardEntry,
  type ManagedGroupCardEntry,
  workspacesCard,
} from '../card/templates';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  secretKeyForApp,
} from '../config/schema';
import type { ProfileAccess, ProfileConfig } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { accessToClaudePermissionMode } from '../config/permissions';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import type { RunControlIcons } from '../card/run-control-icons';
import { refreshLiveRunCard } from '../card/run-refresh';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  projectNameFromCwd,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, type SessionSummary } from '../session/history';
import {
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName, describeChatDeletionError, dissolveChat, isDefaultChatName, renameChat } from '../bot/group';
import { cleanDissolvedChat } from '../bot/group-cleanup';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { applyLarkCliIdentityPolicy, hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';

export interface WorkerReplySync {
  runNow(): Promise<void>;
  stopScope(scope: string): Promise<boolean>;
  ownsRecoveredMessage?(scope: string, messageId: string): boolean;
  stopMessage?(scope: string, messageId: string): Promise<boolean>;
  refreshMessage?(scope: string, messageId: string): Promise<boolean>;
}

export interface Controls {
  /** Reuse normal intake, authorization, durable queue and reply delivery for user-requested card messages. */
  refreshWorkerDiscovery?(): Promise<void>;
  submitMessage?(message: NormalizedMessage): Promise<void>;
  messageQueue?: import('../bot/message-queue').MessageQueue;
  auxiliary?: import('../bot/auxiliary-groups').AuxiliaryGroups;
  auxiliaryApprovals?: import('../bot/auxiliary-approvals').AuxiliaryApprovals;
  toolRegistry?: ToolRegistry;
  toolBindings?: ToolBindingStore;
  defaultToolId?: import('../config/profile-schema').AgentKind;
  executorForTool?(id: import('../config/profile-schema').AgentKind): RunExecutor;
  workerRuntimes?: Map<ToolId, { inbox: import('../worker/inbox').WorkerInbox; replies?: WorkerReplySync }>;
  workerReplySync?: WorkerReplySync;
  workerQuestions?: { handleAction(scope: string, messageId: string, token: string, form?: Record<string, unknown>): Promise<void> };
  workerInbox?: import('../worker/inbox').WorkerInbox;
  sessionArchiveNotifications?: { flush(): Promise<void> };
  /** Refresh a persisted mirrored CardKit delivery using its original sequence owner. */
  refreshMirroredRunCard?(scope: string, messageId: string): Promise<boolean>;
  nativeReplySync?: { stopScope(scope: string, messageId?: string): Promise<boolean>; ownsMessage?(scope: string, messageId: string): boolean };
  runControlIcons?: RunControlIcons;
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect observers, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** Pause AA reconciliation until a fork has its final name and group binding. */
  withAaSessionGroupSyncPaused?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface CommandContext {
  channel: LarkChannel;
  /** Original Feishu channel when a presentation transport captures replies. */
  groupChannel?: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  pending?: import('../bot/pending-queue').PendingQueue;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
  nativeMirrorAction?: boolean;
  /** Web transport awaits results; Feishu callbacks retain their detached updates. */
  fromWeb?: boolean;
  /** Production DM policy: private chat is only a launcher for workspace groups. */
  dmGroupCreationOnly?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: ToolId;
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

type PanelCandidate =
  | {
      kind: 'session';
      toolId?: ToolId;
      sourceId?: string;
      threadId: string;
      cwd: string;
      name?: string;
      preview: string;
      ownerId: string;
      sourceChatId: string;
      expiresAt: number;
    }
  | {
      kind: 'group';
      toolId?: ToolId;
      sourceId?: string;
      chatId: string;
      name: string;
      cwd?: string;
      threadId?: string;
      ownerId: string;
      sourceChatId: string;
      expiresAt: number;
    };

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const PANEL_CANDIDATE_TTL_MS = 15 * 60 * 1000;
const PANEL_PAGE_SIZE = 6;
const SESSION_PAGE_SIZE = 10;
const panelCandidates = new Map<string, PanelCandidate>();
const pendingForks = new Set<string>();
const unboundForks = new Map<string, { threadId: string; name: string; cwd: string }>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/refresh': handleRefresh,
  '/queue': handleQueue,
  '/fork': handleFork,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/finish': handleFinish,
  '/panel': handlePanel,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
};

const DM_TEXT_COMMANDS: Record<string, string> = {
  新建会话: '/new chat setup',
  创建会话: '/new chat setup',
  创建工作群: '/new chat setup',
  新建工作群: '/new chat setup',
  新建群会话: '/new chat setup',
  打开控制台: '/panel',
  任务控制台: '/panel',
  控制台: '/panel',
};

const GROUP_TEXT_COMMANDS: Record<string, string> = {
  终止任务: '/finish',
  打开控制台: '/panel',
  任务控制台: '/panel',
  控制台: '/panel',
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  ctx = await routeCommandContext(ctx);
  const raw = ctx.msg.content.trim();
  if (ctx.chatMode === 'p2p' && raw === '/aux') {
    await ctx.controls.auxiliary?.pendingFor(ctx.msg.senderId);
    return true;
  }
  const auxiliary = ctx.controls.auxiliary;
  if (ctx.msg.chatType !== 'p2p' && auxiliary?.isAuxiliary(ctx.scope)) {
    if (raw === '退出') {
      if (ctx.msg.senderId !== ctx.controls.botOwnerId) { await reply(ctx, '仅所有者可以退出辅助群。'); return true; }
      try { await auxiliary.leave(ctx.msg.chatId, ctx.msg.senderId, () => handleStop('', ctx, true)); }
      catch (err) { await reply(ctx, `退出尚未完成：${errorText(err)}。请再次 @我发送“退出”重试。`); }
      return true;
    }
    if (raw.startsWith('/') && !['/stop', '/refresh'].includes(raw)) {
      await reply(ctx, '辅助群只提供停止、刷新；会话共享设置请所有者私聊机器人。');
      return true;
    }
  }
  const trimmed =
    ctx.chatMode === 'p2p'
      ? (DM_TEXT_COMMANDS[raw] ?? raw)
      : (GROUP_TEXT_COMMANDS[raw] ?? raw);
  if (!trimmed.startsWith('/')) {
    if (ctx.chatMode === 'p2p' && ctx.dmGroupCreationOnly) {
      await handleNew('chat setup', ctx);
      return true;
    }
    return false;
  }
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  if (
    ctx.chatMode === 'p2p' &&
    ctx.dmGroupCreationOnly &&
    !isDmGroupCreationCommand(cmd, args)
  ) {
    await handleNew('chat setup', ctx);
    return true;
  }
  if (auxiliary?.isAuxiliary(ctx.scope) && !['/stop', '/refresh'].includes(cmd)) return true;
  const h = handlers[cmd];
  if (!h) return false;
  if (
    isAdminCommand(cmd) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  ctx = await routeCommandContext(ctx, { skipSessionIdentity: ['finish', 'config'].includes(name) && !args.trim() });
  if (
    ctx.chatMode === 'p2p' &&
    ctx.dmGroupCreationOnly &&
    !isDmGroupCreationCommand(name, args)
  ) {
    await handleNew('chat setup', ctx);
    return true;
  }
  if (ctx.controls.auxiliary?.isAuxiliary(ctx.scope) && !['stop', 'refresh'].includes(name)) return true;
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (
    isAdminCommand(name) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    await reply(ctx, '❌ 此操作仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    if (ctx.fromWeb) throw err;
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === 'chat setup') {
    const knownChats = await refreshKnownChatsForNaming(ctx);
    const card = newChatCreationCard(
      defaultChatName(knownChats.map((chat) => chat.name)),
      effectiveWorkspaceCwd(ctx),
      normalizeModelSelection(
        ctx.controls.profileConfig.agentKind,
        ctx.controls.profileConfig.preferences.model,
      ),
      'high',
      ctx.controls.toolRegistry?.all().map(tool => ({ id: tool.id, label: tool.label })),
      ctx.controls.defaultToolId ?? ctx.controls.profileConfig.agentKind,
    );
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
    return;
  }

  if (trimmed === 'chat form') {
    const groupName = String(ctx.formValue?.group_name ?? '').trim();
    const cwd = String(ctx.formValue?.cwd ?? '').trim();
    const rawTool = String(ctx.formValue?.agent_kind ?? ctx.controls.defaultToolId ?? ctx.controls.profileConfig.agentKind);
    if (!isToolId(rawTool)) return reply(ctx, '❌ 无效的执行工具，请重新创建会话。');
    await handleNewChat(groupName, ctx, cwd, rawTool); return;
  }

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    await handleNewChat(rawName, ctx); return;
  }

  resetNativeReservation(ctx);
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

function resetNativeReservation(ctx: CommandContext): void {
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  if (!binding) return;
  if (binding.nativeId) ctx.controls.toolBindings!.archive(binding.toolId, binding.sourceId, binding.nativeId);
  const tool = ctx.controls.toolRegistry?.find(binding.toolId);
  ctx.controls.toolBindings!.set(ctx.scope, { ...binding, nativeId: tool?.reserveSessionId?.(), nativeCreated: false });
}

function isDmGroupCreationCommand(name: string, args: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  if (normalized === '/panel') return true;
  return normalized === '/new' && (args === 'chat' || args.startsWith('chat '));
}

async function handlePanel(args: string, ctx: CommandContext): Promise<void> {
  const [action = '', arg = ''] = args.trim().split(/\s+/, 2);
  if (
    action &&
    action !== 'refresh' &&
    action !== 'new' &&
    action !== 'new-confirm' &&
    action !== 'stop' &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 全局会话和工作群管理仅管理员可用。');
    return;
  }
  if (action === 'auxiliary' && ctx.chatMode === 'p2p') {
    await ctx.controls.auxiliary?.pendingFor(ctx.msg.senderId); return;
  }
  if (action === 'sessions') {
    await showExistingSessionsPanel(ctx, parsePanelPage(arg));
    return;
  }
  if (action === 'groups') {
    await showManagedGroupsPanel(ctx, parsePanelPage(arg));
    return;
  }
  if (action === 'session-group') {
    await createGroupForPanelSession(ctx, arg);
    return;
  }
  if (action === 'session-archive') {
    const target = panelCandidate(ctx, arg, 'session');
    if (!target) return reply(ctx, '此会话操作已过期，请刷新“现有会话”后重试。');
    await showPanelCard(ctx, panelConfirmationCard({
      title: '确认归档会话',
      description: '会话会从活动列表移入归档，但完整对话记录仍然保留。',
      confirmText: '确认归档（保留记录）',
      confirmCmd: 'panel.session-archive-confirm',
      token: arg,
      backCmd: 'panel.sessions',
    }));
    return;
  }
  if (action === 'session-archive-confirm') {
    await archivePanelSession(ctx, arg);
    return;
  }
  if (action === 'group') {
    const target = panelCandidate(ctx, arg, 'group');
    if (!target) return reply(ctx, '此工作群操作已过期，请刷新“工作群”后重试。');
    await showPanelCard(ctx, managedGroupDetailCard({
      token: arg,
      name: target.name,
      cwd: target.cwd,
      threadId: target.threadId,
    }));
    return;
  }
  if (action === 'group-finish') {
    const target = panelCandidate(ctx, arg, 'group');
    if (!target) return reply(ctx, '此工作群操作已过期，请刷新“工作群”后重试。');
    await showPanelCard(ctx, finishTaskConfirmationCard(target.toolId ?? ctx.controls.profileConfig.agentKind, {
      title: `归档 ${target.name}`,
      archiveCmd: 'panel.group-finish-confirm',
      dissolveCmd: 'panel.group-finish-dissolve',
      token: arg,
    }));
    return;
  }
  if (action === 'group-finish-confirm' || action === 'group-finish-dissolve') {
    await finishPanelGroup(ctx, arg, action === 'group-finish-dissolve');
    return;
  }
  if (action === 'new') {
    await showPanelCard(ctx, newSessionConfirmationCard(ctx.controls.profileConfig.agentKind));
    return;
  }
  if (action === 'stop') {
    await handleStop('', ctx);
  }
  if (action === 'new-confirm') {
    resetNativeReservation(ctx);
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
      ctx.sessionCatalog.archiveActive({ ...ctx.sessionCatalogIdentity, now: Date.now() });
      await ctx.sessionCatalog.flush();
    }
    ctx.sessions.clear(ctx.scope);
    await ctx.sessions.flush();
  }
  await showPanelCard(ctx, buildTaskPanelCard(ctx));
}

function buildTaskPanelCard(ctx: CommandContext): object {
  const chatName =
    ctx.chatMode === 'p2p'
      ? '机器人私聊'
      : (ctx.controls.knownChats?.find((chat) => chat.id === ctx.msg.chatId)?.name ?? '当前群');
  const catalogEntry =
    ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const legacyEntry = ctx.sessions.getRaw(ctx.scope);
  return taskPanelCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    chatName,
    chatMode: ctx.chatMode,
    model: normalizeModelSelection(ctx.controls.profileConfig.agentKind, ctx.controls.cfg.preferences?.model),
    reasoningEffort: ctx.controls.cfg.preferences?.reasoningEffort ?? DEFAULT_REASONING,
    cwd: effectiveWorkspaceCwd(ctx),
    sessionId: catalogEntry?.threadId ?? catalogEntry?.sessionId ?? legacyEntry?.sessionId,
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    groupCount: managedKnownChats(ctx, ctx.controls.knownChats ?? []).length,
    auxiliaryAvailable: !!ctx.controls.auxiliary,
    sessionCount: ctx.sessionCatalog
      ? new Set(
          ctx.sessionCatalog.entries()
            .map((entry) => `${entry.agentId}:${entry.sourceId ?? ''}:${entry.threadId ?? entry.sessionId ?? ''}`)
            .filter(Boolean),
        ).size
      : undefined,
  });
}

async function showPanelCard(ctx: CommandContext, card: object): Promise<void> {
  if (ctx.fromCardAction && isManaged(ctx.msg.messageId)) {
    const channel = ctx.channel;
    const messageId = ctx.msg.messageId;
    const chatId = ctx.msg.chatId;
    // A CardKit button keeps the client-side card snapshot locked until the
    // callback returns. Updating inline can succeed server-side and then be
    // visually reverted by that snapshot. Detach and update after the lock
    // settles, matching the form-submit lifecycle below.
    void (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, PANEL_ACTION_SETTLE_MS));
      try {
        await updateManagedCard(channel, messageId, card);
        log.info('command', 'panel-card-updated', { messageId });
      } catch (err) {
        log.warn('command', 'panel-card-update-fallback', {
          err: err instanceof Error ? err.message : String(err),
        });
        await sendManagedCard(channel, chatId, card).catch((sendErr) =>
          log.fail('command', sendErr, { step: 'panel-card-fallback-send' }),
        );
      }
    })();
    return;
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

const PANEL_ACTION_SETTLE_MS = 1000;

async function showExistingSessionsPanel(ctx: CommandContext, page: number): Promise<void> {
  if (ctx.chatMode !== 'p2p') { await reply(ctx, '请在机器人私聊控制台中管理现有会话。'); return; }
  await ctx.controls.refreshWorkerDiscovery?.();
  let history: (CodexThreadHistoryEntry & { toolId?: ToolId; sourceId?: string })[];
  if (ctx.controls.toolRegistry) {
    history = [];
    for (const tool of ctx.controls.toolRegistry.all()) {
      try {
        const rows = await tool.listSessions();
        history.push(...rows.filter(row => !row.archived && !ctx.controls.toolBindings?.isArchived(tool.id, tool.sourceId, row.nativeId))
          .map(row => ({ threadId: row.nativeId, name: row.name, cwd: row.cwd, createdAtMs: row.createdAtMs,
            updatedAtMs: row.updatedAtMs, preview: '', source: tool.id, toolId: tool.id, sourceId: tool.sourceId })));
      } catch (err) { log.warn('panel', 'history-unavailable', { toolId: tool.id, err: errorText(err) }); }
    }
    history.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  } else history = [];
  const start = page * SESSION_PAGE_SIZE;
  const slice = history.slice(start, start + SESSION_PAGE_SIZE);
  const entries: ExistingSessionCardEntry[] = slice.map((thread) => ({
    token: issuePanelCandidate(ctx, {
      kind: 'session',
      toolId: thread.toolId, sourceId: thread.sourceId,
      threadId: thread.threadId,
      cwd: thread.cwd,
      ...(thread.name ? { name: thread.name } : {}),
      preview: thread.preview,
    }),
    title: `${thread.toolId ? `${toolDefinition(thread.toolId).label} · ` : ''}${thread.name || thread.preview || '未命名会话'}`,
    preview: thread.name && thread.preview !== thread.name ? thread.preview : '保留原会话上下文',
    cwd: thread.cwd,
    threadId: thread.threadId,
    relTime: formatRelTime(thread.updatedAtMs),
  }));
  await showPanelCard(ctx, existingSessionsCard(entries, page, history.length > start + SESSION_PAGE_SIZE));
}

async function showManagedGroupsPanel(ctx: CommandContext, page: number): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '请在机器人私聊控制台中统一管理工作群。');
    return;
  }
  const chats = managedKnownChats(ctx, await refreshKnownChatsForNaming(ctx));
  const catalogEntries = ctx.sessionCatalog?.entries() ?? [];
  const start = page * PANEL_PAGE_SIZE;
  const slice = chats.slice(start, start + PANEL_PAGE_SIZE);
  const entries: ManagedGroupCardEntry[] = slice.map((chat) => {
    const bound = catalogEntries
      .filter((entry) => entry.scopeId === chat.id && entry.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const cwd = bound?.cwdRealpath ?? ctx.workspaces.cwdFor(chat.id);
    const token = issuePanelCandidate(ctx, {
      kind: 'group',
      toolId: bound?.agentId, sourceId: bound?.sourceId,
      chatId: chat.id,
      name: chat.name,
      ...(cwd ? { cwd } : {}),
      ...((bound?.threadId ?? bound?.sessionId) ? { threadId: bound?.threadId ?? bound?.sessionId } : {}),
    });
    return { token, name: chat.name, ...(cwd ? { cwd } : {}), ...((bound?.threadId ?? bound?.sessionId) ? { threadId: bound?.threadId ?? bound?.sessionId } : {}) };
  });
  await showPanelCard(ctx, managedGroupsCard(entries, page, chats.length > start + PANEL_PAGE_SIZE));
}

async function createGroupForPanelSession(
  ctx: CommandContext,
  token: string,
  options: { exactName?: boolean; forked?: boolean; recentTurnReplayCount?: number } = {},
): Promise<boolean> {
  const target = panelCandidate(ctx, token, 'session');
  const tool = target && ctx.controls.toolRegistry?.find(target.toolId ?? ctx.controls.profileConfig.agentKind);
  const create = () => createGroupForPanelSessionUnlocked(ctx, token, options);
  return target && tool && ctx.controls.toolBindings
    ? ctx.controls.toolBindings.withPersonalBinding({ toolId: tool.id, sourceId: tool.sourceId, nativeId: target.threadId }, create)
    : create();
}

async function createGroupForPanelSessionUnlocked(
  ctx: CommandContext,
  token: string,
  options: { exactName?: boolean; forked?: boolean; recentTurnReplayCount?: number } = {},
): Promise<boolean> {
  const target = panelCandidate(ctx, token, 'session');
  if (!target) {
    await reply(ctx, '此会话操作已过期，请刷新“现有会话”后重试。');
    return false;
  }
  const toolId = target.toolId ?? ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  ctx = { ...ctx, agent: tool?.agent ?? ctx.agent, controls: controlsForTool(ctx.controls, toolId) };
  if (target.sourceId && tool?.sourceId !== target.sourceId) throw new Error('会话数据来源已变化');
  if (tool && !await tool.agent.isAvailable()) {
    await reply(ctx, `❌ ${tool.label} 不可用，请检查本机安装和认证。`);
    return false;
  }
  try {
    if (tool && (ctx.controls.toolBindings?.isArchived(toolId, tool.sourceId, target.threadId) || (await tool.listSessions()).find(row => row.nativeId === target.threadId)?.archived)) {
      await reply(ctx, '会话已归档，不会为此会话创建群。');
      return false;
    }
  } catch {
    await reply(ctx, '暂时无法确认会话归档状态，请稍后重试。');
    return false;
  }
  const owner = tool && ctx.controls.toolBindings?.personalOwner({ toolId, sourceId: tool.sourceId, nativeId: target.threadId });
  const alreadyBound = ctx.sessionCatalog?.entries().find(
    (entry) => entry.status === 'active' && entry.agentId === toolId && (!entry.sourceId || entry.sourceId === tool?.sourceId) && (entry.threadId ?? entry.sessionId) === target.threadId &&
      (!entry.botAppId || entry.botAppId === ctx.controls.profileConfig.accounts.app.id) && !ctx.sessionCatalog!.isScopeArchived(entry.scopeId) &&
      isPersonalWorkgroup(entry.scopeId, ctx.controls.toolBindings?.get(entry.scopeId)),
  );
  const ownerScope = owner ?? alreadyBound?.scopeId;
  if (ownerScope) {
    const group = ctx.controls.knownChats?.find((chat) => chat.id === ownerScope);
    if (options.exactName && target.name && group && group.name !== target.name) {
      await renameChat(ctx.channel, group.id, target.name);
      group.name = target.name;
    }
    await reply(ctx, `此会话已经绑定工作群 **${group?.name ?? ownerScope}**，未重复创建。`);
    return true;
  }
  const workspace = await resolveWorkingDirectory(target.cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return false;
  }
  // A fork's app-server title is authoritative. Feishu permits same-name
  // groups, so never append another suffix or truncate that title here.
  const name = options.exactName && target.name
    ? target.name
    : uniqueSessionGroupName(target.name || target.preview,
      (await refreshKnownChatsForNaming(ctx)).map((chat) => chat.name));
  // Naming may involve a network lookup. Recheck before creating a binding.
  if (tool) {
    try {
      if (ctx.controls.toolBindings?.isArchived(toolId, tool.sourceId, target.threadId) ||
          (await tool.listSessions()).find(row => row.nativeId === target.threadId)?.archived) {
        await reply(ctx, '会话已归档，不会为此会话创建群。'); return false;
      }
    } catch { await reply(ctx, '暂时无法确认会话归档状态，请稍后重试。'); return false; }
  }
  let created;
  try {
    created = await createBoundChat({ channel: ctx.groupChannel ?? ctx.channel, name, inviteOpenId: ctx.msg.senderId, toolId });
  } catch (err) {
    await reply(ctx, `❌ 创建群失败：${errorText(err)}`);
    return false;
  }
  if (tool && ctx.controls.toolBindings) {
    ctx.controls.toolBindings.set(created.chatId, { toolId, sourceId: tool.sourceId, nativeId: target.threadId, nativeCreated: true, name });
    await ctx.controls.toolBindings.flush();
  }
  ctx.workspaces.setCwd(created.chatId, workspace.cwdRealpath);
  await saveAccessConfig(ctx, (current) => ({
    ...current,
    allowedChats: [...new Set([...current.allowedChats, created.chatId])],
  }));
  ctx.controls.knownChats = [
    ...(ctx.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
    { id: created.chatId, name: created.name },
  ];
  const identity = panelGroupIdentity(ctx, created.chatId, workspace.cwdRealpath);
  if (!identity || !ctx.sessionCatalog) {
    await reply(ctx, '⚠️ 群已创建，但会话绑定失败；请在新群中使用“恢复会话”重新绑定。');
    return false;
  }
  ctx.sessionCatalog.upsertActive({
    ...identity,
    ...nativeSessionFields(toolId, target.threadId),
    sourceId: tool?.sourceId,
    botAppId: ctx.controls.profileConfig.accounts.app.id,
    ...(options.recentTurnReplayCount ? { recentTurnReplayCount: options.recentTurnReplayCount } : {}),
  });
  await Promise.all([ctx.workspaces.flush(), ctx.sessionCatalog.flush()]);
  await sendManagedCard(
    ctx.channel,
    created.chatId,
    newChatWorkspaceCard(created.name, { threadId: target.threadId, existing: true }, toolId),
  ).catch((err) => log.warn('command', 'existing-session-welcome-failed', { err: errorText(err) }));
  await reply(ctx, options.forked
    ? `✓ 已创建分叉工作群 **${created.name}**，并绑定同名的新会话。原会话和原群保持不变。`
    : `✓ 已创建群 **${created.name}**，并绑定原会话 \`${target.threadId.slice(0, 8)}…\`。`);
  return true;
}

function managedKnownChats(ctx: CommandContext, chats: KnownChat[]): KnownChat[] {
  const workspaceScopes = new Set(Object.keys(ctx.workspaces.listCwds()));
  const catalogScopes = new Set(
    (ctx.sessionCatalog?.entries() ?? []).map((entry) => entry.scopeId),
  );
  return chats.filter((chat) => !ctx.controls.auxiliary?.isAuxiliary(chat.id) && (workspaceScopes.has(chat.id) || catalogScopes.has(chat.id)));
}

async function archivePanelSession(ctx: CommandContext, token: string): Promise<void> {
  const target = panelCandidate(ctx, token, 'session');
  if (!target) return reply(ctx, '此会话操作已过期，请刷新“现有会话”后重试。');
  const toolId = target.toolId ?? ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  if (!tool || !ctx.controls.toolBindings || (target.sourceId && target.sourceId !== tool.sourceId)) throw new Error('会话来源已变化');
  if (tool.sessions?.nativeArchive) await tool.sessions.archive(target.threadId);
  ctx.controls.toolBindings.archive(toolId, tool.sourceId, target.threadId);
  ctx.sessionCatalog?.archiveNativeSession(toolId, target.threadId, tool.sourceId, true);
  for (const row of ctx.sessionCatalog?.entries() ?? []) if (row.agentId === toolId && (row.sessionId ?? row.threadId) === target.threadId && (!row.sourceId || row.sourceId === tool.sourceId)) ctx.sessionCatalog?.archiveScope(row.scopeId, target.threadId);
  await Promise.all([ctx.controls.toolBindings.flush(), ctx.sessionCatalog?.flush()]);
  await ctx.controls.sessionArchiveNotifications?.flush();
  panelCandidates.delete(token); await reply(ctx, `✓ ${tool.label} 会话已归档，历史保留。`);
}

function usesArchiveNotification(ctx: CommandContext, scope: string, nativeId?: string): boolean {
  const binding = ctx.controls.toolBindings?.get(scope);
  return !!ctx.controls.sessionArchiveNotifications && !!nativeId && /^oc_[A-Za-z0-9]+$/.test(scope) &&
    !!binding && binding.nativeId === nativeId && !binding.linkedSource && !binding.sharedScope && !binding.auxiliaryWorkgroup &&
    !ctx.controls.auxiliary?.isAuxiliary(scope) && !!ctx.sessionCatalog?.entries().some(row => row.scopeId === scope &&
      row.status === 'active' && row.agentId === binding.toolId && (row.threadId ?? row.sessionId) === nativeId &&
      (!row.sourceId || row.sourceId === binding.sourceId) && (!row.botAppId || row.botAppId === ctx.controls.profileConfig.accounts.app.id));
}

async function finishPanelGroup(ctx: CommandContext, token: string, dissolve = false): Promise<void> {
  const target = panelCandidate(ctx, token, 'group');
  if (!target) return reply(ctx, '此工作群操作已过期，请刷新“工作群”后重试。');
  if (dissolve && !await canDissolveGroup(ctx)) return;
  const scopes = ctx.activeRuns.scopes().filter(scope => scope === target.chatId || scope.startsWith(`${target.chatId}:`));
  await ctx.activeRuns.stopScopes(scopes);
  const binding = ctx.controls.toolBindings?.get(target.chatId);
  const nativeId = target.threadId ?? binding?.nativeId;
  const notified = usesArchiveNotification(ctx, target.chatId, nativeId);
  const toolId = target.toolId ?? binding?.toolId ?? ctx.controls.profileConfig.agentKind;
  if (scopes.length === 0) await controlsForTool(ctx.controls, toolId).workerReplySync?.stopScope(target.chatId);
  const tool = ctx.controls.toolRegistry?.find(toolId);
  if (nativeId && tool?.sessions?.nativeArchive) {
    try { await tool.sessions.archive(nativeId); }
    catch (error) { await reply(ctx, `❌ 会话归档失败，群保持不变：${errorText(error)}`); return; }
  }
  if (binding && nativeId) { ctx.controls.toolBindings!.archive(toolId, binding.sourceId, nativeId); await ctx.controls.toolBindings!.flush(); }
  await archiveGroupInput(ctx, target.chatId, nativeId ?? `pending-${toolId}`);
  panelCandidates.delete(token);
  const notice = `✓ 已归档工作群「${target.name}」，后续消息不再响应。` +
    (dissolve ? '正在解散群，原生会话历史保留。' : '群和会话历史已保留。');
  if (notified) await ctx.controls.sessionArchiveNotifications!.flush();
  else await ctx.channel.send(target.chatId, { text: notice });
  if (dissolve) await dissolveArchivedGroup(ctx, target.chatId);
  else if (ctx.msg.chatId !== target.chatId) await reply(ctx, notice);
}

/** Web entry to the same personal group creation as `/new chat`; replies go to `ctx.msg.chatId`. */
export async function createPersonalWorkgroup(ctx: CommandContext, name: string, cwd: string, toolId: ToolId): Promise<{ chatId: string; name: string } | undefined> {
  return handleNewChat(name, ctx, cwd, toolId);
}

async function handleNewChat(
  rawName: string,
  ctx: CommandContext,
  requestedCwd?: string,
  selectedTool?: ToolId,
  options: { copiedFrom?: CopiedSessionSource; uuid?: string } = {},
): Promise<{ chatId: string; name: string } | undefined> {
  const toolId = selectedTool ?? ctx.controls.defaultToolId ?? ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  const targetAgent = tool?.agent ?? ctx.agent;
  if (ctx.controls.toolRegistry && !tool) {
    await reply(ctx, `❌ ${toolDefinition(toolId).label} worker 未发现，请启动后重试。`); return;
  }
  if (tool && (targetAgent.id !== toolId || !await targetAgent.isAvailable())) {
    await reply(ctx, `❌ ${toolDefinition(toolId).label} 不可用，请检查本机安装和认证${toolDefinition(toolId).backend === 'worker' ? '，以及独立 worker 服务' : ''}。`);
    return;
  }
  let sourceCwd = effectiveWorkspaceCwd(ctx);
  if (requestedCwd !== undefined) {
    if (!requestedCwd || !isAbsoluteOrTilde(requestedCwd)) {
      await reply(ctx, '❌ 工作目录必须是绝对路径，或使用 `~/xxx`。');
      return;
    }
    const workspace = await resolveWorkingDirectory(expandTilde(requestedCwd));
    if (!workspace.ok) {
      await reply(ctx, workspace.userVisible);
      return;
    }
    sourceCwd = workspace.cwdRealpath;
  }
  let name = rawName;
  if (!name || (!options.copiedFrom && isDefaultChatName(name))) {
    const knownChats = await refreshKnownChatsForNaming(ctx);
    const existingNames = knownChats.map((chat) => chat.name);
    if (!name || existingNames.includes(name)) name = defaultChatName(existingNames);
  }

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.groupChannel ?? ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
      toolId,
      uuid: options.uuid,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  if (ctx.controls.toolBindings && tool) {
    const previousCopy = options.copiedFrom ? ctx.controls.toolBindings.get(created.chatId) : undefined;
    if (previousCopy && previousCopy.copiedFrom?.copyId !== options.copiedFrom?.copyId) throw new Error('建群返回了其他会话的群，未更改绑定。');
    ctx.controls.toolBindings.set(created.chatId, previousCopy ?? { toolId, sourceId: tool.sourceId, name: created.name, nativeId: tool.reserveSessionId?.(), nativeCreated: false, createdAtMs: Date.now(),
      ...(options.copiedFrom ? { copiedFrom: options.copiedFrom } : {}),
      model: toolId === ctx.controls.profileConfig.agentKind ? ctx.controls.profileConfig.preferences.model ?? 'default' : 'default',
      reasoningEffort: 'high' });
    await ctx.controls.toolBindings.flush();
  }
  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
    await ctx.workspaces.flush();
  }

  await saveAccessConfig(ctx, (current) => ({
    ...current,
    allowedChats: [...new Set([...current.allowedChats, created.chatId])],
  }));
  ctx.controls.knownChats = [
    ...(ctx.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
    { id: created.chatId, name: created.name },
  ];

  const setupCard = newChatWorkspaceCard(created.name, undefined, toolId);
  try {
    await sendManagedCard(ctx.channel, created.chatId, setupCard);
  } catch (err) {
    console.warn('[new-chat] setup card failed:', err);
    const usage = '当前只有你和机器人时可直接发任务；邀请其他同事后，请使用 `@机器人 + 任务内容`。';
    const welcome = sourceCwd
      ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n${usage}\n\n发送 \`/cd <绝对路径>\` 可调整目录。`
      : `🎉 群已建好。${usage}\n\n发送 \`/cd <绝对路径>\` 设置工作目录。`;
    await ctx.channel.send(created.chatId, { markdown: welcome }).catch((fallbackErr) =>
      console.warn('[new-chat] welcome fallback failed:', fallbackErr),
    );
  }

  if (options.copiedFrom) {
    try {
      await readCopiedSession({ ...ctx, scope: created.chatId, chatMode: 'group', fromCardAction: true,
        msg: { ...ctx.msg, chatId: created.chatId, chatType: 'group', threadId: undefined, messageId: '' },
      }, options.copiedFrom.copyId);
    } catch (error) {
      await ctx.channel.send(created.chatId, { text: `⚠️ 新会话已创建，自动读取原会话失败：${errorText(error)}。请稍后在新会话中要求读取原会话。` });
    }
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
  return created;
}

async function refreshKnownChatsForNaming(ctx: CommandContext): Promise<KnownChat[]> {
  const cached = ctx.controls.knownChats ?? [];
  const fetched = await fetchKnownChats(ctx.channel);
  if (fetched.length > 0) {
    ctx.controls.knownChats = fetched;
    return fetched;
  }
  return cached;
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const rawInput = args.trim();
  const input =
    rawInput === 'form'
      ? String(ctx.formValue?.cwd ?? '').trim()
      : rawInput.startsWith('apply ')
        ? rawInput.slice('apply '.length).trim()
        : rawInput;
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  const toolId = ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  const identity = ctx.sessionCatalogIdentity;
  const current = identity && ctx.sessionCatalog?.activeFor(identity);
  const rows = tool ? (await tool.listSessions()).filter(row => !row.archived && row.cwd === cwd).sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, limit) : [];
  const entries = rows.map(row => ({ sessionId: identity ? issueResumeCandidate(identity,
    nativeSessionFields(toolId, row.nativeId) as { sessionId: string } | { threadId: string }) : row.nativeId,
    preview: row.name ?? row.nativeId, relTime: formatRelTime(row.updatedAtMs), detail: tool?.label,
    current: row.nativeId === (current?.threadId ?? current?.sessionId) }));
  await ctx.channel.send(ctx.msg.chatId, { card: resumeCard(cwd, entries) }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      const toolId = ctx.sessionCatalogIdentity.agentId;
      const current = ctx.controls.toolBindings?.get(ctx.scope);
      const sourceId = ctx.controls.toolRegistry?.find(toolId)?.sourceId ?? current?.sourceId;
      if (sourceId) try {
        ctx.controls.toolBindings?.assertPersonalBinding(ctx.scope, { ...current, toolId, sourceId, nativeId: resolved.threadId ?? resolved.sessionId });
      } catch (error) {
        if (!(error instanceof PersonalBindingConflict)) throw error;
        await reply(ctx, error.message); return;
      }
      const nativeId = resolved.threadId ?? resolved.sessionId!;
      const tool = ctx.controls.toolRegistry?.find(toolId);
      const row = tool ? (await tool.listSessions()).find(row => row.nativeId === nativeId) : undefined;
      if (tool && (!row || row.archived || row.cwd !== ctx.sessionCatalogIdentity.cwdRealpath)) return reply(ctx, '会话已失效或归档，请重新选择。');
      ctx.activeRuns.interrupt(ctx.scope);
      ctx.sessionCatalog.upsertActive({ ...ctx.sessionCatalogIdentity, ...nativeSessionFields(toolId, nativeId),
        sourceId, rebindArchivedScope: true, botAppId: ctx.controls.profileConfig.accounts.app.id });
      if (current && sourceId) { ctx.controls.toolBindings!.set(ctx.scope, { ...current, toolId, sourceId, nativeId, nativeCreated: true }); await ctx.controls.toolBindings!.flush(); }
      if (toolDefinition(toolId).nativeField === 'sessionId') ctx.sessions.set(ctx.scope, nativeId, ctx.sessionCatalogIdentity.cwdRealpath);
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    if (toolDefinition(ctx.sessionCatalogIdentity.agentId).nativeField === 'threadId') {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (toolDefinition(ctx.sessionCatalogIdentity.agentId).nativeField === 'sessionId') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (toolDefinition(ctx.controls.profileConfig.agentKind).nativeField === 'threadId') {
    await reply(ctx, '当前上下文没有可恢复的 Codex thread，请先在当前工作区完成一次运行。');
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    (toolDefinition(identity.agentId).nativeField === 'sessionId' && !candidate.sessionId) ||
    (toolDefinition(identity.agentId).nativeField === 'threadId' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

function issuePanelCandidate(
  ctx: CommandContext,
  input:
    | { kind: 'session'; toolId?: ToolId; sourceId?: string; threadId: string; cwd: string; name?: string; preview: string }
    | { kind: 'group'; toolId?: ToolId; sourceId?: string; chatId: string; name: string; cwd?: string; threadId?: string },
): string {
  prunePanelCandidates();
  let token = randomUUID().slice(0, 12);
  while (panelCandidates.has(token)) token = randomUUID().slice(0, 12);
  panelCandidates.set(token, {
    ...input,
    ownerId: ctx.msg.senderId,
    sourceChatId: ctx.msg.chatId,
    expiresAt: Date.now() + PANEL_CANDIDATE_TTL_MS,
  } as PanelCandidate);
  return token;
}

function panelCandidate(
  ctx: CommandContext,
  token: string,
  kind: 'session',
): Extract<PanelCandidate, { kind: 'session' }> | undefined;
function panelCandidate(
  ctx: CommandContext,
  token: string,
  kind: 'group',
): Extract<PanelCandidate, { kind: 'group' }> | undefined;
function panelCandidate(
  ctx: CommandContext,
  token: string,
  kind: PanelCandidate['kind'],
): PanelCandidate | undefined {
  prunePanelCandidates();
  const candidate = panelCandidates.get(token);
  if (
    !candidate ||
    candidate.kind !== kind ||
    candidate.ownerId !== ctx.msg.senderId ||
    candidate.sourceChatId !== ctx.msg.chatId
  ) {
    return undefined;
  }
  return candidate;
}

function prunePanelCandidates(now = Date.now()): void {
  for (const [token, candidate] of panelCandidates.entries()) {
    if (candidate.expiresAt <= now) panelCandidates.delete(token);
  }
}

function parsePanelPage(input: string): number {
  const page = Number.parseInt(input, 10);
  return Number.isFinite(page) && page >= 0 ? Math.min(page, 20) : 0;
}

function panelGroupIdentity(
  ctx: CommandContext,
  chatId: string,
  cwdRealpath: string,
): SessionCatalogIdentity | undefined {
  const access = canUseGroup(
    ctx.controls.profileConfig,
    ctx.controls,
    chatId,
    ctx.msg.senderId,
  );
  const capability = capabilityForTool(ctx.controls.profileConfig.agentKind, ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatId, actorId: ctx.msg.senderId },
    attachments: [],
    prompt: '',
    requestedCwd: cwdRealpath,
    cwdRealpath,
    access,
    capability,
    profileConfig: ctx.controls.profileConfig,
    now: Date.now(),
  });
  if (!policy.ok) return undefined;
  return {
    scopeId: chatId,
    agentId: capability.agentId,
    cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function uniqueSessionGroupName(title: string, existingNames: string[]): string {
  const normalized = title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const base = (normalized || 'AI会话').slice(0, 48);
  const used = new Set(existingNames.map((name) => name.trim()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  return { label: 'access', value: profileConfig.permissions.defaultAccess };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = toolDefinition(ctx.controls.profileConfig.agentKind).nativeField === 'threadId';
  const catalogEntry =
    isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isCodex ? '(未建立)' : undefined,
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleFork(args: string, ctx: CommandContext): Promise<void> {
  const [action, token] = args.trim().split(/\s+/);
  try {
    if (action === 'read') { await readCopiedSession(ctx, token ?? ''); return; }
    if (!action) { await showSessionCopyMenu(ctx); return; }
    if (action !== 'same' && action !== 'to') return reply(ctx, '请重新打开复制会话面板。');
    const choice = token ? await sessionCopyChoice(ctx, token) : undefined;
    if (action === 'same' && !choice && toolDefinition(ctx.controls.profileConfig.agentKind).fork) {
      await handleNativeFork(ctx); return;
    }
    if (!choice || (action === 'same' && choice.target !== ctx.controls.profileConfig.agentKind)) throw new Error('复制入口已失效，请重新打开。');
    if (choice.creating) return reply(ctx, '正在创建会话，请稍候。');
    if (choice.created) return reply(ctx, '此会话已创建，请到新群继续。');
    const rawName = ctx.formValue?.new_session_name ?? choice.defaultName;
    if (typeof rawName !== 'string') throw new Error('名称需为 1–100 字。');
    const name = rawName.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error('名称需为 1–100 字，不能包含控制字符。');
    if (choice.name && choice.name !== name) throw new Error('此操作已提交，请重新打开复制会话面板。');
    choice.name = name;
    choice.creating = true;
    try {
      if (action === 'same' && toolDefinition(choice.target).fork) {
        if (await handleNativeFork(ctx, name)) choice.created = true;
        return;
      }
      if (!ctx.controls.toolBindings || !ctx.controls.toolRegistry) throw new Error('工具会话管理尚未就绪。');
      const source = await currentCopySource(ctx);
      const created = await handleNewChat(name, ctx, source.cwd, choice.target, { copiedFrom: choice.source, uuid: choice.source.copyId });
      if (created) choice.created = true;
    } finally { choice.creating = false; }
  } catch (error) { await reply(ctx, `❌ ${errorText(error)}`); }
}

async function handleNativeFork(ctx: CommandContext, name?: string): Promise<boolean> {
  const toolId = ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  const nativeFork = tool?.sessions?.fork;
  if (!toolDefinition(toolId).fork || (!nativeFork && !ctx.agent.forkThread) || !ctx.sessionCatalog) {
    await reply(ctx, '当前工具不支持会话分叉。'); return false;
  }
  if (name && !tool?.sessions?.rename && !ctx.agent.renameSession) {
    await reply(ctx, '当前工具不支持修改新会话名字。'); return false;
  }
  const botAppId = ctx.controls.profileConfig.accounts.app.id;
  const exact = ctx.sessionCatalogIdentity ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity) : undefined;
  const source = exact ?? ctx.sessionCatalog.entries()
    .filter((entry) => entry.status === 'active' && entry.agentId === toolId &&
      entry.scopeId === ctx.scope && entry.botAppId === botAppId && (!tool || !entry.sourceId || entry.sourceId === tool.sourceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const sourceNativeId = source && nativeSessionId(toolId, source);
  if (!sourceNativeId || source?.botAppId !== botAppId || source.agentId !== toolId || (tool && source.sourceId && source.sourceId !== tool.sourceId)) {
    await reply(ctx, `当前群尚未绑定本机器人的 ${toolDefinition(toolId).label} 会话，无法复制。`); return false;
  }
  if (ctx.activeRuns.get(ctx.scope)) { await reply(ctx, '请先停止当前任务，再复制会话。'); return false; }
  const key = JSON.stringify([botAppId, toolId, tool?.sourceId, sourceNativeId]);
  if (pendingForks.has(key)) { await reply(ctx, '正在创建分叉，请稍候。'); return false; }
  pendingForks.add(key);
  try {
    const createForkAndGroup = async () => {
      let fork = unboundForks.get(key);
      if (!fork) {
        if (nativeFork) {
          const copy = await nativeFork.call(tool!.sessions!, sourceNativeId);
          fork = { threadId: copy.nativeId, name: copy.name, cwd: copy.cwd };
        } else fork = await ctx.agent.forkThread!(sourceNativeId);
      }
      // A group-creation retry must not create another native fork.
      unboundForks.set(key, fork);
      if (name && fork.name !== name) {
        if (tool?.sessions?.rename) await tool.sessions.rename(fork.threadId, name);
        else await ctx.agent.renameSession!(fork.threadId, name, fork.cwd);
        fork.name = name;
      }
      const token = issuePanelCandidate(ctx, { kind: 'session', ...fork, toolId, sourceId: tool?.sourceId, preview: fork.name });
      try {
        const bound = await createGroupForPanelSession(ctx, token, {
          exactName: true, forked: true,
          // Preserve the existing creation-time history replay for AA groups.
          ...(fork.name.startsWith('AA') ? { recentTurnReplayCount: 3 } : {}),
        });
        if (bound) unboundForks.delete(key);
        else await reply(ctx, `⚠️ 分叉 **${fork.name}** 已创建，建群尚未完成。再次点击“分叉”可重试建群，不会重复分叉。`);
        return bound;
      } finally { panelCandidates.delete(token); }
    };
    // Cover naming AND direct binding: the periodic AA scanner must not
    // discover the new thread in the gap and create a competing group.
    if (ctx.controls.withAaSessionGroupSyncPaused) {
      return await ctx.controls.withAaSessionGroupSyncPaused(createForkAndGroup);
    } else {
      return await createForkAndGroup();
    }
  } catch (err) {
    const fork = unboundForks.get(key);
    await reply(ctx, fork
      ? `⚠️ 分叉 **${fork.name}** 已创建，命名或建群失败：${errorText(err)}。再次点击可重试，不会重复分叉。`
      : `❌ 分叉失败：${errorText(err)}`);
    return false;
  } finally {
    pendingForks.delete(key);
  }
}

async function handleQueue(args: string, ctx: CommandContext): Promise<void> {
  const [action, id] = args.trim().split(/\s+/);
  if (!ctx.fromCardAction || action !== 'remove' || !id || !ctx.controls.messageQueue) return;
  try {
    if (!await ctx.controls.messageQueue.remove(ctx.scope, id, ctx.msg.senderId))
      await reply(ctx, '该消息已开始处理或已移除，未停止当前任务。');
  } catch (error) { await reply(ctx, `⚠️ ${errorText(error)}`); }
}

async function handleRefresh(_args: string, ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    try {
      if (await refreshLiveRunCard(ctx.msg.messageId, ctx.scope) ||
          await ctx.controls.refreshMirroredRunCard?.(ctx.scope, ctx.msg.messageId)) {
        log.info('command', 'refresh-card-in-place', { scope: ctx.scope, messageId: ctx.msg.messageId });
        return;
      }
    } catch (err) {
      log.warn('command', 'refresh-card-failed', { scope: ctx.scope, message: errorText(err) });
      await reply(ctx, '⚠️ 刷新失败，请稍后重试。原卡片已保留。');
      return;
    }
  }
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  const tool = binding && ctx.controls.toolRegistry?.find(binding.toolId);
  if (!binding?.nativeId || !(tool?.agent instanceof DurableAgentAdapter) || !(await tool.agent.client.health()).capabilities?.conversation) {
    if (ctx.fromCardAction) await reply(ctx, '当前卡片没有可刷新的会话。');
    else await handleStatus('', ctx);
    return;
  }
  try {
    const snapshot = await tool.agent.client.conversation(binding.nativeId), turn = snapshot.turns.at(-1);
    if (!turn) return reply(ctx, '当前会话没有可刷新的回复。');
    // Shared groups may only refresh a journal delivery owned by their scope.
    if (binding.linkedSource || binding.auxiliaryWorkgroup) return reply(ctx, '请使用当前任务的刷新按钮。');
    const card = renderCard({ ...turn.state, projectName: projectNameFromCwd(snapshot.cwd) }, ctx.controls.runControlIcons);
    if (ctx.fromCardAction) await ctx.channel.updateCard(ctx.msg.messageId, card);
    else await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
  } catch (error) { await reply(ctx, `⚠️ 刷新失败：${errorText(error)}。原卡片已保留。`); }
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext, strict = false): Promise<void> {
  const auxiliary = ctx.controls.auxiliary;
  if (!strict && auxiliary?.isAuxiliary(ctx.scope) &&
    (!auxiliary.canStop(ctx.scope, ctx.msg.senderId, auxiliary.get(ctx.scope)?.running?.id) || args.trim())) return;
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const scope = targetScope || ctx.scope;
  // A native mirror card owns exactly one turn. Do not fall through to a
  // newer worker task or another session after that card's turn has ended.
  if (ctx.fromCardAction && (ctx.nativeMirrorAction || ctx.controls.nativeReplySync?.ownsMessage?.(scope, ctx.msg.messageId))) {
    const stopped = await ctx.controls.nativeReplySync?.stopScope(scope, ctx.msg.messageId) ?? false;
    log.info('command', 'native-stop', { scope, messageId: ctx.msg.messageId, interrupted: stopped });
    if (!stopped) await reply(ctx, '该条桌面回复已结束或当前轮次已变化，未停止其他任务。');
    return;
  }
  if (ctx.fromCardAction && ctx.controls.workerReplySync?.ownsRecoveredMessage?.(scope, ctx.msg.messageId)) {
    await ctx.controls.workerReplySync.stopMessage?.(scope, ctx.msg.messageId);
    return;
  }
  const handle = strict ? ctx.activeRuns.get(scope) : undefined;
  let ok: boolean;
  if (handle) {
    handle.interrupted = true;
    await handle.run.stop();
    ctx.activeRuns.unregister(scope, handle.run);
    ok = true;
  } else ok = ctx.activeRuns.interrupt(scope);
  if (!ok && ctx.controls.workerReplySync) ok = await ctx.controls.workerReplySync.stopScope(scope);
  if (!ok && ctx.controls.nativeReplySync) ok = await ctx.controls.nativeReplySync.stopScope(scope);
  if (!ok) {
    const binding = ctx.controls.toolBindings?.get(scope);
    const tool = binding && ctx.controls.toolRegistry?.find(binding.toolId);
    if (binding?.nativeId && !binding.linkedSource && !binding.auxiliaryWorkgroup && tool?.agent instanceof DurableAgentAdapter && (await tool.agent.client.health()).capabilities?.nativeTurnStop) {
      const snapshot = await tool.agent.client.conversation(binding.nativeId), turn = snapshot.turns.at(-1);
      if (turn?.state.terminal === 'running' && !snapshot.archived) ok = await tool.agent.client.stopNativeTurn(binding.nativeId, turn.id, snapshot.cwd);
    }
  }
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function archiveGroupInput(ctx: CommandContext, chatId: string, nativeId: string): Promise<void> {
  const matches = (scope: string) => scope === chatId || scope.startsWith(`${chatId}:`);
  const scopes = new Set([chatId, ...(ctx.sessionCatalog?.entries() ?? []).filter(e => matches(e.scopeId)).map(e => e.scopeId),
    ...(ctx.pending?.snapshot() ?? []).filter(e => matches(e.scope)).map(e => e.scope)]);
  for (const scope of scopes) {
    ctx.sessionCatalog?.archiveScope(scope, nativeId, true);
    ctx.sessions.remove(scope);
    ctx.pending?.cancel(scope);
    await ctx.controls.workerInbox?.rejectScope(scope);
  }
  await Promise.all([ctx.sessions.flush(), ctx.sessionCatalog?.flush()]);
}

async function canDissolveGroup(ctx: CommandContext): Promise<boolean> {
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '仅所有者或管理员可以归档并解散群。');
    return false;
  }
  if (!ctx.sessionCatalog) {
    await reply(ctx, '暂时无法保存群关联状态，请稍后重试。');
    return false;
  }
  return true;
}

/** Called only after native/local archival succeeded. Never send into a deleted group. */
async function dissolveArchivedGroup(ctx: CommandContext, chatId: string): Promise<void> {
  try { await dissolveChat(ctx.groupChannel ?? ctx.channel, chatId); }
  catch (error) {
    await reply(ctx, `会话已归档，解散群失败：${describeChatDeletionError(error)}`);
    return;
  }
  try {
    await cleanDissolvedChat({ channel: ctx.groupChannel ?? ctx.channel, controls: ctx.controls,
      catalog: ctx.sessionCatalog!, sessions: ctx.sessions, workspaces: ctx.workspaces,
      cancelPending: async scope => {
        ctx.pending?.cancel(scope);
        for (const runtime of ctx.controls.workerRuntimes?.values() ?? []) await runtime.inbox.rejectScope(scope);
      } }, chatId);
  } catch (error) {
    log.fail('command', error, { step: 'dissolved-group-cleanup', chatId });
    if (ctx.fromWeb || ctx.msg.chatId !== chatId) await reply(ctx, '会话已归档，群已解散。群关联清理尚未完成，将由后台检查重试。');
    return;
  }
  if (ctx.fromWeb || ctx.msg.chatId !== chatId) await reply(ctx, '✓ 会话已归档并解散群，原生会话历史已保留。');
}

async function handleFinish(args: string, ctx: CommandContext): Promise<void> {
  const toolName = ctx.controls.toolRegistry?.find(ctx.controls.profileConfig.agentKind)?.label ??
    (toolDefinition(ctx.controls.profileConfig.agentKind).label);
  if (ctx.chatMode === 'p2p') {
    await reply(ctx, `❌ “终止任务”只能在要结束的 ${toolName} 工作群中使用。`);
    return;
  }
  if (ctx.chatMode === 'topic') {
    await reply(ctx, `❌ “终止任务”暂不支持话题模式，请在普通 ${toolName} 工作群中操作。`);
    return;
  }

  const action = args.trim();
  const dissolve = action === 'archive-dissolve';
  if (action !== 'archive' && action !== 'confirm' && !dissolve) {
    await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      finishTaskConfirmationCard(ctx.controls.profileConfig.agentKind),
      commandReplyOptions(ctx),
    );
    return;
  }
  if (dissolve && !await canDissolveGroup(ctx)) return;

  const groupScopes = ctx.activeRuns
    .scopes()
    .filter((scope) => scope === ctx.msg.chatId || scope.startsWith(`${ctx.msg.chatId}:`));
  // Legacy finish.confirm cards also archive only; never dissolve a group.
  await reply(
    ctx,
    `⏳ 正在停止任务并归档当前 ${toolName} 会话…`,
  );
  await ctx.activeRuns.stopScopes(groupScopes);
  if (toolDefinition(ctx.controls.profileConfig.agentKind).backend === 'worker' && groupScopes.length === 0) await ctx.controls.workerReplySync?.stopScope(ctx.scope);

  const catalogEntry =
    ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const notified = usesArchiveNotification(ctx, ctx.msg.chatId,
    catalogEntry?.threadId ?? catalogEntry?.sessionId ?? ctx.controls.toolBindings?.get(ctx.scope)?.nativeId);
  const toolId = ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId), binding = ctx.controls.toolBindings?.get(ctx.scope);
  const nativeId = catalogEntry?.threadId ?? catalogEntry?.sessionId ?? binding?.nativeId;
  if (nativeId && tool?.sessions?.nativeArchive) {
    try { await tool.sessions.archive(nativeId); }
    catch (error) { await reply(ctx, `❌ 会话归档失败：${errorText(error)}`); return; }
  }
  if (binding && nativeId) { ctx.controls.toolBindings!.archive(toolId, binding.sourceId, nativeId); await ctx.controls.toolBindings!.flush(); }
  ctx.sessionCatalog?.archiveScope(ctx.scope, nativeId ?? `pending-${toolId}`, true);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    if (nativeId) ctx.sessionCatalog.archiveNativeSession(toolId, nativeId, binding?.sourceId);
    else ctx.sessionCatalog.archiveActive({ ...ctx.sessionCatalogIdentity, now: Date.now() });
    await ctx.sessionCatalog.flush();
  }
  await archiveGroupInput(ctx, ctx.msg.chatId, catalogEntry?.threadId ?? catalogEntry?.sessionId ?? binding?.nativeId ?? `pending-${ctx.controls.profileConfig.agentKind}`);
  log.info('command', 'finish', { chatId: ctx.msg.chatId, threadId: catalogEntry?.threadId, stoppedRuns: groupScopes.length });
  if (notified)
    await ctx.controls.sessionArchiveNotifications!.flush();
  else await reply(ctx, `✓ 当前 ${toolName} 会话已归档，后续消息不再响应。` +
    (dissolve ? '正在解散群，原生会话历史保留。' : '群和会话历史已保留。'));
  if (dissolve) await dissolveArchivedGroup(ctx, ctx.msg.chatId);
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在重连，已提交的任务继续运行…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.disconnectAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability =
    capabilityForTool(ctx.controls.profileConfig.agentKind, ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending')), ctx.controls.runControlIcons),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus())), ctx.controls.runControlIcons));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
          ctx.controls.runControlIcons,
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  await sendReplacementManagedCard(ctx, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

/** Never reply to a message we have already recalled, or erase a failed navigation. */
async function sendReplacementManagedCard(ctx: CommandContext, card: object): Promise<void> {
  const replyOptions = ctx.fromCardAction && ctx.chatMode !== 'topic'
    ? {}
    : commandReplyOptions(ctx);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, replyOptions);
  if (ctx.fromCardAction && ctx.chatMode !== 'topic') {
    await recallMessage(ctx, ctx.msg.messageId);
    forgetManagedCard(ctx.msg.messageId);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '`/remove group` 请在要移除的群里发，私聊里没有可移除的群。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  try {
    return await withConfigFileLock(ctx.controls.configPath, async () => {
      const root = await loadRootConfig(ctx.controls.configPath);
      if (!root) {
        const access = mutate(ctx.controls.profileConfig.access);
        ctx.controls.profileConfig = {
          ...ctx.controls.profileConfig,
          access,
        };
        ctx.controls.cfg.preferences = {
          ...(ctx.controls.cfg.preferences ?? {}),
          access: {
            allowedUsers: access.allowedUsers,
            allowedChats: access.allowedChats,
            admins: access.admins,
          },
          requireMentionInGroup: access.requireMentionInGroup,
        };
        await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
        return access;
      }

      const profile = root.profiles[ctx.controls.profile];
      if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
      const access = mutate(profile.access);
      root.profiles[ctx.controls.profile] = {
        ...profile,
        access,
      };
      await saveRootConfig(root, ctx.controls.configPath);
      ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
      ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
      log.info('command', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
      });
      return access;
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'access.save' });
    throw err;
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'models':
      return showConfigForm(ctx, { refreshModels: true, modelPage: Number(args.trim().split(/\s+/)[1]) || 0, updateForm: true });
    case 'page':
      return showConfigForm(ctx, { modelPage: Number(args.trim().split(/\s+/)[1]) || 0, updateForm: true });
    case 'preview':
      if (ctx.fromWeb) return showConfigForm(ctx, { preview: true, updateForm: true });
      void (async () => {
        await new Promise(resolve => setTimeout(resolve, FORM_SETTLE_MS));
        await showConfigForm(ctx, { preview: true, updateForm: true });
      })().catch(error => log.warn('command', 'config-preview-failed', { err: String(error) }));
      return;
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext,
  { modelPage = 0, preview = false, updateForm = false, refreshModels = false }: { modelPage?: number; preview?: boolean; updateForm?: boolean; refreshModels?: boolean } = {},
): Promise<void> {
  if (refreshModels) await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  const draft = preview || updateForm ? ctx.formValue ?? {} : {};
  const selectedModel = normalizeModelSelection(ctx.controls.profileConfig.agentKind, String(draft.model ?? ctx.controls.cfg.preferences?.model ?? DEFAULT_MODEL));
  const cwd = effectiveWorkspaceCwd(ctx);
  const tool = ctx.controls.toolRegistry?.find(ctx.controls.profileConfig.agentKind);
  const profileDir = commandProfilePaths(ctx).profileDir;
  const appId = ctx.controls.profileConfig.accounts.app.id;
  const modelChoices = await cachedModelChoices(modelCachePath(profileDir, appId, ctx.agent.id, tool?.sourceId, cwd), ctx.agent, cwd, selectedModel, refreshModels,
    { fallbackPath: modelCachePath(profileDir, appId, ctx.agent.id, tool?.sourceId) });
  let selectedEffort = normalizeReasoningEffort(ctx.controls.profileConfig.agentKind,
    String(draft.reasoning_effort ?? ctx.controls.cfg.preferences?.reasoningEffort ?? ''));
  let reasoningNotice: string | undefined;
  const settingsScope = ctx.controls.toolBindings?.settingsScope(ctx.scope);
  const binding = settingsScope ? ctx.controls.toolBindings?.get(settingsScope) : undefined;
  if (refreshModels && !preview && binding?.nativeId && binding.nativeCreated !== false &&
      (!binding.reasoningEffort || binding.reasoningEffort === DEFAULT_REASONING) && ctx.agent.readReasoning) {
    try {
      const selection = await ctx.agent.readReasoning(binding.nativeId, effectiveWorkspaceCwd(ctx));
      selectedEffort = selection.effort;
      reasoningNotice = selection.notice;
      const current = ctx.controls.toolBindings?.get(settingsScope!);
      if (selection.source === 'native' && current?.nativeId === binding.nativeId && current?.sourceId === binding.sourceId) {
        ctx.controls.toolBindings!.set(settingsScope!, { ...current, reasoningEffort: selectedEffort });
        await ctx.controls.toolBindings!.flush();
      }
    } catch { reasoningNotice = '暂时无法读取原会话档位，初始选择高；保存后按所选模型自动适配。'; }
  }
  const card = configFormCard({
    modelOptions: modelChoices.options, modelPage, unpagedModels: ctx.fromWeb,
    agentKind: ctx.controls.profileConfig.agentKind,
    model: selectedModel,
    reasoningEffort: selectedEffort, reasoningNotice,
    modelNotice: modelChoices.notice,
    messageReply: ['card', 'text', 'markdown'].includes(String(draft.message_reply)) ? draft.message_reply as MessageReplyMode : getMessageReplyMode(ctx.controls.cfg),
    cotMessages: ['off', 'brief', 'detailed'].includes(String(draft.cot_messages)) ? draft.cot_messages as 'off' | 'brief' | 'detailed' : getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: Number.isFinite(Number(draft.max_concurrent_runs)) && Number(draft.max_concurrent_runs) >= 1 ? Math.min(50, Math.floor(Number(draft.max_concurrent_runs))) : getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
  });
  if (updateForm && ctx.fromCardAction && isManaged(ctx.msg.messageId)) {
    await updateManagedCard(ctx.channel, ctx.msg.messageId, card);
    return;
  }
  // Settings can be opened from an answer's footer as well as the console.
  // Keep that carrier message (and its controls) intact throughout the form.
  const replyOptions = ctx.fromCardAction && ctx.chatMode !== 'topic'
    ? {}
    : commandReplyOptions(ctx);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, replyOptions);
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  if (ctx.fromWeb) {
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
    return;
  }
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromWeb) return showResultCardInPlace(ctx, ctx.msg.messageId, configCancelledCard());
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools === 'show' ? true : rawTools === 'hide' ? false : getShowToolCalls(ctx.controls.cfg);
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelSelection = normalizeModelSelection(agentKind, rawModel || ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const rawReasoningEffort = String(fv.reasoning_effort ?? '').trim();
  const reasoningEffort = normalizeReasoningEffort(agentKind, rawReasoningEffort || ctx.controls.cfg.preferences?.reasoningEffort);
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  const previousLarkCliIdentity = ctx.controls.profileConfig.larkCli.identityPreset;
  const larkCliIdentityChanged = larkCliIdentity !== previousLarkCliIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  const save = async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      if (ctx.fromWeb) return;
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      reasoningEffort,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
    };

    let modelOptions: import('../agent/models').ModelOption[] | undefined;
    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (rawReasoningEffort && rawReasoningEffort !== DEFAULT_REASONING &&
          !UNIFIED_REASONING.includes(rawReasoningEffort as typeof UNIFIED_REASONING[number])) {
        await waitForSettle();
        await showResultCardInPlace(ctx, formMsgId, configFailedCard('请选择统一推理档位；原设置未修改。'));
        return;
      }
      if (rawModel && model) {
        const choices = await loadModelChoices(ctx.agent, effectiveWorkspaceCwd(ctx));
        if (!choices.available || !choices.options.some(option => option.value === modelSelection && !option.unavailable)) {
          await waitForSettle();
          await showResultCardInPlace(ctx, formMsgId, configFailedCard('模型列表已变化或暂时无法读取，请在设置中点击“刷新模型”后选择；原设置未修改。'));
          return;
        }
        modelOptions = choices.options;
      }
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, larkCliIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousLarkCliIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousLarkCliIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        model: modelSelection,
        modelOptions,
        reasoningEffort: reasoningEffort ?? DEFAULT_REASONING,
        messageReply,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  };
  if (ctx.fromWeb) await save();
  else void save();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = commandProfilePaths(ctx);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: ctx.controls.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('command', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = commandProfilePaths(ctx);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(ctx.controls.configPath);
  if (!root) {
    await saveConfig(newCfg, ctx.controls.configPath);
    ctx.controls.cfg = newCfg;
    return;
  }

  const profile = root.profiles[ctx.controls.profile];
  if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
  root.profiles[ctx.controls.profile] = {
    ...profile,
    accounts: newCfg.accounts,
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, ctx.controls.configPath);
  ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
  ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<void> {
  const bound = ctx.controls.toolBindings?.get(ctx.scope);
  if (bound) {
    const settingsScope = ctx.controls.toolBindings!.settingsScope(ctx.scope);
    if (!settingsScope) throw new Error('无法唯一确定原工作群，请在原工具会话中设置模型。');
    const settings = ctx.controls.toolBindings!.get(settingsScope)!;
    ctx.controls.toolBindings!.set(settingsScope, { ...settings, model: preferences.model ?? 'default', reasoningEffort: preferences.reasoningEffort });
    await ctx.controls.toolBindings!.flush();
    const base = await loadRootConfig(ctx.controls.configPath);
    const original = base?.profiles[ctx.controls.profile]?.preferences;
    preferences = { ...preferences, model: original?.model, reasoningEffort: original?.reasoningEffort };
  }

  const larkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  await withConfigFileLock(ctx.controls.configPath, async () => {
    const root = await loadRootConfig(ctx.controls.configPath);
    if (!root) {
      ctx.controls.cfg.preferences = preferences;
      ctx.controls.profileConfig.larkCli = larkCli;
      await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
      return;
    }

    const profile = root.profiles[ctx.controls.profile];
    if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    root.profiles[ctx.controls.profile] = {
      ...profile,
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      larkCli,
    };
    await saveRootConfig(root, ctx.controls.configPath);
    ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
    ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
  });
}
