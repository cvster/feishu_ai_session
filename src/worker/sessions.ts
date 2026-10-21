import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import type { AgentAdapter } from '../agent/types';
import type { ToolId } from '../tools/definitions';
import type { ToolSessionOperations } from '../tools/types';
import { ClaudeSessionProvider } from '../tools/claude-sessions';
import { KiloSessionProvider } from '../tools/kilo-sessions';
import { DshSessionProvider } from '../tools/dsh-sessions';
import { ZcodeSessionProvider } from '../tools/zcode-sessions';
import { nativeSessionOperations } from '../tools/session-operations';
import type { WorkerSessionHistory, WorkerSessionService } from './protocol';
import { WorkerApiError } from './tool-api';

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** Export records across the transport, never an arbitrary caller-supplied file path. */
export async function exportWorkerHistory(provider: ToolSessionOperations, nativeId: string): Promise<WorkerSessionHistory | undefined> {
  const path = await provider.historyPath(nativeId);
  if (!path) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) throw new WorkerApiError(413, 'Session history is too large', 'invalid-request');
    // Snapshot the bounded prefix even when native JSONL is still being appended.
    const bytes = Buffer.alloc(stat.size);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (provider.historyMode !== 'snapshot' && length && bytes[length - 1] !== 10) length = bytes.lastIndexOf(10, length - 1) + 1;
    const content = bytes.subarray(0, length).toString('utf8');
    return { nativeId, format: provider.historyMode === 'snapshot' ? 'json' : 'jsonl', content };
  } finally { await file.close(); }
}

/** Provider construction is the only tool-specific part of the worker session API. */
export function createWorkerSessions(input: {
  toolId: ToolId; sourceId: string; profileDir: string; profile: ProfileConfig; agent: AgentAdapter;
}): WorkerSessionService {
  const { toolId, sourceId, profileDir, profile, agent } = input;
  let provider: ToolSessionOperations;
  let list: WorkerSessionService['list'];
  let nativeArchive = true;
  if (toolId === 'claude') {
    const history = new ClaudeSessionProvider(sourceId);
    list = () => history.listSessions();
    provider = nativeSessionOperations({ id: toolId, sourceId, agent });
    nativeArchive = false; // Claude archival belongs to the bridge catalog.
  } else if (toolId === 'kilo') {
    const sessions = new KiloSessionProvider({ binary: profile.kilo?.binaryPath, args: profile.kilo?.args,
      dataHome: profile.kilo?.dataHome, editorSync: profile.kilo?.editorSync, preferredClient: profile.kilo?.preferredClient }, join(profileDir, 'kilo-sessions'));
    provider = sessions; list = () => sessions.listSessions();
  } else if (toolId === 'dsh') {
    const sessions = new DshSessionProvider({ binary: profile.dsh?.binaryPath, args: profile.dsh?.args,
      homeDir: profile.dsh?.homeDir }, join(profileDir, 'dsh-sessions'));
    provider = sessions; list = () => sessions.listSessions();
  } else if (toolId === 'zcode') {
    const sessions = new ZcodeSessionProvider({ binary: profile.zcode?.binaryPath, args: profile.zcode?.args,
      dataDir: profile.zcode?.dataDir, modelConfigPath: profile.zcode?.modelConfigPath,
      remoteControlFile: profile.zcode?.remoteControlFile }, join(profileDir, 'zcode-sessions'),
    agent.renameSession ? (id, name, cwd) => agent.renameSession!(id, name, cwd) : undefined);
    provider = sessions; list = () => sessions.listSessions();
    nativeArchive = false; // The existing ZCode provider only archives in the catalog.
  } else {
    throw new Error('Codex uses its native queue, not an execution worker');
  }
  return { list,
    history: id => exportWorkerHistory(provider, id),
    rename: (id, name) => provider.rename(id, name),
    ...(nativeArchive ? { archive: (id: string) => provider.archive(id) } : {}),
    ...(provider.fork ? { fork: (id: string) => provider.fork!(id) } : {}),
  };
}
