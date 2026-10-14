import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProfileConfig, AgentKind } from '../config/profile-schema';
import type { AppPaths } from '../config/app-paths';
import type { AgentAdapter } from '../agent/types';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { listCodexThreadHistory } from '../session/codex-history';
import { ToolRegistry } from './types';
import { ClaudeSessionProvider } from './claude-sessions';
import { DurableClaudeAdapter } from '../worker/adapter';
import { WorkerClient } from '../worker/client';

export function createToolRegistry(profile: ProfileConfig, paths: AppPaths, primary: AgentAdapter): ToolRegistry {
  const registry = new ToolRegistry();
  const larkChannel = { profile: paths.profile, rootDir: paths.rootDir, configPath: paths.configFile,
    larkCliConfigDir: paths.larkCliConfigDir, larkCliSourceConfigFile: paths.larkCliSourceConfigFile };
  const codex = profile.codex ?? { binaryPath: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex', inheritCodexHome: true };
  const codexAgent = primary.id === 'codex' ? primary : new CodexAdapter({
    binary: codex.binaryPath, profileStateDir: paths.profileDir, codexHome: codex.codexHome,
    inheritCodexHome: codex.inheritCodexHome, ignoreUserConfig: codex.ignoreUserConfig,
    ignoreRules: codex.ignoreRules, sandbox: profile.sandbox.defaultMode, larkChannel,
  });
  registry.register({ id: 'codex', label: 'Codex', sourceId: resolve(codex.codexHome ?? process.env.CODEX_HOME ?? (codex.inheritCodexHome !== false ? join(homedir(), '.codex') : join(paths.profileDir, 'codex-home'))),
    agent: codexAgent, listSessions: async () => (await listCodexThreadHistory({ binary: codex.binaryPath,
      limit: 10_000, profileStateDir: paths.profileDir, codexHome: codex.codexHome, inheritCodexHome: codex.inheritCodexHome, timeoutMs: 60_000,
    })).map(row => ({ nativeId: row.threadId, name: row.name, cwd: row.cwd,
      createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs })) });
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const claudeHistory = new ClaudeSessionProvider(claudeHome);
  registry.register({ id: 'claude', label: 'Claude Code', sourceId: resolve(claudeHome),
    reserveSessionId: randomUUID,
    agent: new DurableClaudeAdapter(new WorkerClient(join(paths.profileDir, 'execution-worker'), resolve(claudeHome), profile.accounts.app.id),
      primary.id === 'claude' ? primary : new ClaudeAdapter({ binary: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude', larkChannel })),
    listSessions: () => claudeHistory.listSessions() });
  return registry;
}

export function toolProfile(profile: ProfileConfig, toolId: AgentKind): ProfileConfig {
  return { ...profile, agentKind: toolId,
    ...(toolId === 'claude' ? { codex: undefined } : {}),
    preferences: { ...profile.preferences,
      model: toolId === profile.agentKind ? profile.preferences.model : undefined } };
}
