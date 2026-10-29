import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProfileConfig } from '../config/profile-schema';
import type { LarkChannelEnvContext } from '../agent/lark-channel-env';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { KiloAdapter } from '../agent/kilo/adapter';
import { ZcodeAdapter } from '../agent/zcode/adapter';
import { DshAdapter } from '../agent/dsh/adapter';
import { PiAdapter } from '../agent/pi/adapter';
import { piStorageDir } from '../agent/pi/client';
import { kiloStorageDir } from '../agent/kilo/client';
import { zcodeStorageDir } from '../agent/zcode/client';
import { dshStorageDir } from '../agent/dsh/client';
import { loadWorkerConfig } from './config';
import { createWorkerSessions } from './sessions';
import type { AgentAdapter } from '../agent/types';
import type { WorkerManifest } from './protocol';

/** Native provider selection and local tool paths belong entirely to the worker. */
export async function createWorkerProvider(profileDir: string, toolId: string, profile: ProfileConfig, larkChannel: LarkChannelEnvContext) {
  const config = await loadWorkerConfig(profileDir, toolId, profile), stateDir = join(profileDir, 'workers', toolId);
  const options = config.options as any;
  let agent: AgentAdapter, sourceId: string;
  if (toolId === 'codex') {
    sourceId = resolve(options.codexHome ?? process.env.CODEX_HOME ?? (options.inheritCodexHome !== false ? join(homedir(), '.codex') : join(profileDir, 'codex-home')));
    agent = new CodexAdapter({ binary: options.binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex', profileStateDir: stateDir,
      codexHome: sourceId, inheritCodexHome: true,
      sandbox: profile.sandbox.defaultMode, appServerRemote: options.appServerRemote ?? process.env.CODEX_QUEUE_REMOTE, larkChannel });
  } else if (toolId === 'claude') {
    sourceId = resolve(options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = sourceId;
    agent = new ClaudeAdapter({ binary: options.binaryPath ?? process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude', larkChannel });
  } else if (toolId === 'kilo') {
    sourceId = kiloStorageDir(options); agent = new KiloAdapter({ ...options, binary: options.binaryPath, larkChannel });
  } else if (toolId === 'zcode') {
    sourceId = zcodeStorageDir(options); agent = new ZcodeAdapter({ ...options, binary: options.binaryPath, larkChannel });
  } else if (toolId === 'dsh') {
    sourceId = dshStorageDir(options); agent = new DshAdapter({ ...options, binary: options.binaryPath, larkChannel });
  } else if (toolId === 'pi') {
    sourceId = piStorageDir(options); agent = new PiAdapter({ ...options, binary: options.binaryPath, larkChannel });
  } else throw new Error(`No built-in provider for ${toolId}; external workers register through their own endpoint.json`);
  const selected = { ...profile, [toolId]: options };
  const sessions = createWorkerSessions({ toolId, sourceId, profileDir: stateDir, profile: selected, agent });
  const manifest: WorkerManifest = { label: agent.displayName, nativeField: toolId === 'codex' ? 'threadId' : 'sessionId',
    sessionKind: toolId === 'codex' ? 'codex-thread' : `${toolId}-session`, historyFormat: ['codex', 'claude', 'pi'].includes(toolId) ? 'jsonl' : 'json',
    nativeHistory: ['claude', 'pi'].includes(toolId) };
  return { stateDir, sourceId, agent, sessions, manifest, maxConcurrent: toolId === 'zcode' && options.remoteControlFile ? 1 : undefined };
}
