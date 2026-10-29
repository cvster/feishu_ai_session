import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import type { AgentAdapter } from '../agent/types';
import type { ToolId } from '../tools/definitions';
import type { ToolSessionOperations } from '../tools/types';
import { ClaudeSessionProvider } from '../tools/claude-sessions';
import { KiloSessionProvider } from '../tools/kilo-sessions';
import { DshSessionProvider } from '../tools/dsh-sessions';
import { PiSessionProvider } from '../tools/pi-sessions';
import { PiNativeConversationReader } from '../agent/pi/conversation';
import { ZcodeSessionProvider } from '../tools/zcode-sessions';
import { nativeSessionOperations } from '../tools/session-operations';
import type { WorkerSessionHistory, WorkerSessionService } from './protocol';
import { WorkerApiError } from './tool-api';
import { createCodexWorkerSessions } from './codex-sessions';
import { ClaudeNativeConversationReader } from '../agent/claude/conversation';
import { DshNativeConversationReader } from '../agent/dsh/conversation';
import { KiloNativeConversationReader } from '../agent/kilo/conversation';
import { ZcodeNativeConversationReader } from '../agent/zcode/conversation';

export { exportWorkerHistory } from './history';
import { exportWorkerHistory } from './history';

/** Provider construction is the only tool-specific part of the worker session API. */
export function createWorkerSessions(input: {
  toolId: ToolId; sourceId: string; profileDir: string; profile: ProfileConfig; agent: AgentAdapter;
}): WorkerSessionService {
  const { toolId, sourceId, profileDir, profile, agent } = input;
  let provider: ToolSessionOperations;
  let list: WorkerSessionService['list'];
  let nativeArchive = true;
  if (toolId === 'codex') return createCodexWorkerSessions({ binary: profile.codex?.binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex',
    profileStateDir: profileDir, codexHome: sourceId, inheritCodexHome: true, sharedServer: true,
    remote: (profile.codex as unknown as { appServerRemote?: string })?.appServerRemote ?? process.env.CODEX_QUEUE_REMOTE }, sourceId, agent, profile.accounts.app.id);
  let reader: import('../agent/native-conversation').NativeConversationReader | undefined;
  if (toolId === 'claude') {
    reader = new ClaudeNativeConversationReader(sourceId);
    const history = new ClaudeSessionProvider(sourceId);
    list = () => history.listSessions();
    provider = nativeSessionOperations({ id: toolId, sourceId, agent });
    nativeArchive = false; // Claude archival belongs to the bridge catalog.
  } else if (toolId === 'kilo') {
    const sessions = new KiloSessionProvider({ binary: profile.kilo?.binaryPath, args: profile.kilo?.args,
      dataHome: profile.kilo?.dataHome, editorSync: profile.kilo?.editorSync, client: profile.kilo?.client }, join(profileDir, 'kilo-sessions'));
    reader = new KiloNativeConversationReader({ binary: profile.kilo?.binaryPath, args: profile.kilo?.args, dataHome: profile.kilo?.dataHome, editorSync: profile.kilo?.editorSync, client: profile.kilo?.client });
    provider = sessions; list = () => sessions.listSessions();
  } else if (toolId === 'pi') {
    const options = { binary: profile.pi?.binaryPath, args: profile.pi?.args, agentDir: profile.pi?.agentDir };
    const sessions = new PiSessionProvider(options);
    reader = new PiNativeConversationReader(options);
    provider = sessions; list = () => sessions.listSessions();
  } else if (toolId === 'dsh') {
    const sessions = new DshSessionProvider({ binary: profile.dsh?.binaryPath, args: profile.dsh?.args,
      homeDir: profile.dsh?.homeDir }, join(profileDir, 'dsh-sessions'));
    reader = new DshNativeConversationReader({ binary: profile.dsh?.binaryPath, args: profile.dsh?.args, homeDir: profile.dsh?.homeDir });
    provider = sessions; list = () => sessions.listSessions();
  } else if (toolId === 'zcode') {
    const sessions = new ZcodeSessionProvider({ binary: profile.zcode?.binaryPath, args: profile.zcode?.args,
      dataDir: profile.zcode?.dataDir, modelConfigPath: profile.zcode?.modelConfigPath,
      remoteControlFile: profile.zcode?.remoteControlFile }, join(profileDir, 'zcode-sessions'),
    agent.renameSession ? (id, name, cwd) => agent.renameSession!(id, name, cwd) : undefined);
    provider = sessions; list = () => sessions.listSessions();
    nativeArchive = false; // The existing ZCode provider only archives in the catalog.
    reader = new ZcodeNativeConversationReader({ binary: profile.zcode?.binaryPath, args: profile.zcode?.args, dataDir: profile.zcode?.dataDir },
      profile.zcode?.remoteControlFile && agent.stopNativeTurn ? (id, turnId, cwd) => agent.stopNativeTurn!(id, turnId, cwd) : undefined);
  } else {
    throw new Error(`No built-in session provider for ${toolId}`);
  }
  return { list,
    ...(['kilo', 'pi'].includes(toolId) ? { listAuthoritative: true } : {}),
    nativeNames: toolId !== 'zcode' || !!profile.zcode?.remoteControlFile,
    ...(reader ? { conversation: (id: string) => reader!.read(id), close: () => reader!.close() } : {}),
    history: id => exportWorkerHistory(provider, id),
    rename: (id, name) => provider.rename(id, name),
    ...(nativeArchive ? { archive: (id: string) => provider.archive(id) } : {}),
    ...(provider.archiveEffect ? { archiveEffect: provider.archiveEffect } : {}),
    ...(provider.fork ? { fork: (id: string) => provider.fork!(id) } : {}),
  };
}
