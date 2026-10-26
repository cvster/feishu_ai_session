import { listCodexModels } from './models';
import type { SandboxMode } from '../../config/profile-schema';
import { SpawnFailed } from '../../runtime/errors';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { createCodexQueueRun } from './queue';
import { createCodexQueuedFreshRun } from './queued-fresh-run';
import { archiveCodexThread, setCodexThreadName } from '../../session/codex-history';
import { codexBridgeClientMessageId } from '../../session/codex-origin';
import { CodexThreadReader } from '../../session/codex-thread-reader';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  sandbox?: SandboxMode;
  larkChannel?: LarkChannelEnvContext;
  /** Shared app-server endpoint used for queueing and thread mutations. */
  appServerRemote?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly sandbox: SandboxMode;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly appServerRemote: string | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.larkChannel = opts.larkChannel;
    this.appServerRemote = opts.appServerRemote ?? process.env.CODEX_QUEUE_REMOTE;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  listModels(options: { cwd?: string } = {}) {
    return listCodexModels({ binary: this.binary, profileStateDir: this.profileStateDir, codexHome: this.codexHome, inheritCodexHome: this.inheritCodexHome, remote: this.appServerRemote, cwd: options.cwd });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await setCodexThreadName({
      binary: this.binary,
      threadId,
      name,
      profileStateDir: this.profileStateDir,
      ...(this.codexHome ? { codexHome: this.codexHome } : {}),
      inheritCodexHome: this.inheritCodexHome,
      // The live writer also notifies Desktop; an owned reader only updates history.
      remote: this.appServerRemote ?? 'unix://',
    });
  }

  async stopNativeTurn(threadId: string, turnId: string, cwd: string): Promise<boolean> {
    const reader = new CodexThreadReader({ binary: this.binary, profileStateDir: this.profileStateDir, codexHome: this.codexHome,
      inheritCodexHome: this.inheritCodexHome, sharedServer: true, passive: true, remote: this.appServerRemote });
    try {
      const snapshot = await reader.readThread(threadId), turn = snapshot.turns.at(-1);
      if (snapshot.id !== threadId || turn?.id !== turnId || turn.status !== 'inProgress' || snapshot.status?.type !== 'active') return false;
      // Native directory ownership is checked before the common worker API invokes this method.
      await reader.interruptTurn(threadId, turnId); return true;
    } finally { await reader.stop(); }
  }

  async archiveThread(threadId: string): Promise<void> {
    await archiveCodexThread({
      binary: this.binary,
      threadId,
      profileStateDir: this.profileStateDir,
      ...(this.codexHome ? { codexHome: this.codexHome } : {}),
      inheritCodexHome: this.inheritCodexHome,
      remote: this.appServerRemote,
    });
  }

  async forkThread(threadId: string): Promise<{ threadId: string; name: string; cwd: string }> {
    const reader = new CodexThreadReader({
      binary: this.binary,
      profileStateDir: this.profileStateDir,
      ...(this.codexHome ? { codexHome: this.codexHome } : {}),
      inheritCodexHome: this.inheritCodexHome,
      sharedServer: Boolean(this.appServerRemote),
      ...(this.appServerRemote ? { remote: this.appServerRemote } : {}),
      timeoutMs: 60_000,
    });
    try {
      return await reader.forkThread(threadId);
    } finally {
      await reader.stop();
    }
  }

  /** Every Codex turn goes through the native queue: fresh threads create one,
   * existing threads enqueue into the one Codex Desktop owns. */
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    if (!opts.threadId) {
      return createCodexQueuedFreshRun({
        runId: opts.runId, binary: this.binary, profileStateDir: this.profileStateDir,
        codexHome: this.codexHome, inheritCodexHome: this.inheritCodexHome,
        cwd: opts.cwd, sandbox: opts.sandbox ?? this.sandbox, prompt: opts.prompt,
        sessionName: opts.sessionName,
        clientUserMessageId: codexBridgeClientMessageId(opts.runId),
        images: opts.images, model: opts.model, reasoningEffort: opts.reasoningEffort,
        remote: this.appServerRemote, env: buildLarkChannelEnv(this.larkChannel),
      });
    }

    return createCodexQueueRun({
      runId: opts.runId,
      binary: this.binary,
      profileStateDir: this.profileStateDir,
      ...(this.codexHome ? { codexHome: this.codexHome } : {}),
      inheritCodexHome: this.inheritCodexHome,
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      prompt: opts.prompt,
      clientUserMessageId: codexBridgeClientMessageId(opts.runId),
      images: opts.images,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      ...(this.appServerRemote ? { remote: this.appServerRemote } : {}),
      env: buildLarkChannelEnv(this.larkChannel),
    });
  }
}
