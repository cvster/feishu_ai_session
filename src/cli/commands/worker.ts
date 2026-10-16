import { zcodeStorageDir } from '../../agent/zcode/client';
import { ZcodeAdapter } from '../../agent/zcode/adapter';
import { isToolId, toolDefinition, workerStateDirName, type ToolId } from '../../tools/definitions';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { configureLogger } from '../../core/logger';
import { startWorkerServer } from '../../worker/server';
import { WorkerClient } from '../../worker/client';
import { getMaxConcurrentRuns } from '../../config/schema';
import { loadRuntimeEnv } from '../../config/runtime-env';

interface WorkerOptions { profile?: string; config?: string; tool?: string }
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
export function buildWorkerUnit(inputs: { node: string; entry: string; profile: string; config: string; envPath: string; claudeConfigDir?: string; binary?: string; toolId?: ToolId; zcodeBinary?: string; zcodeDataDir?: string }): string {
  return `[Unit]
Description=Lark independent ${inputs.toolId ? toolDefinition(inputs.toolId).label : 'Claude'} execution worker (${inputs.profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quote(inputs.node)} ${quote(inputs.entry)} worker run --profile ${quote(inputs.profile)} --config ${quote(inputs.config)}${inputs.toolId && inputs.toolId !== 'claude' ? ` --tool ${inputs.toolId}` : ''}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
Environment=${quote(`PATH=${inputs.envPath}`)}
${inputs.claudeConfigDir ? `Environment=${quote(`CLAUDE_CONFIG_DIR=${inputs.claudeConfigDir}`)}\n` : ''}${inputs.binary ? `Environment=${quote(`LARK_CHANNEL_CLAUDE_BIN=${inputs.binary}`)}\n` : ''}${inputs.zcodeBinary ? `Environment=${quote(`LARK_CHANNEL_ZCODE_BIN=${inputs.zcodeBinary}`)}\n` : ''}${inputs.zcodeDataDir ? `Environment=${quote(`ZCODE_STORAGE_DIR=${inputs.zcodeDataDir}`)}\n` : ''}
[Install]
WantedBy=default.target
`;
}
async function workerContext(options: WorkerOptions) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? 'codex';
  await loadRuntimeEnv(profile, rootDir);
  const paths = resolveAppPaths({ profile, rootDir });
  const config = await loadRootConfig(paths.configFile);
  const selected = config?.profiles[profile];
  if (!selected) throw new Error(`profile not found: ${profile}`);
  const toolId = options.tool ?? 'claude';
  if (!isToolId(toolId) || toolDefinition(toolId).backend !== 'worker') throw new Error('worker --tool 仅支持注册为 worker 的工具：claude、zcode');
  const sourceId = toolId === 'claude' ? resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) : zcodeStorageDir(selected.zcode);
  return { paths, selected, sourceId, toolId, stateDir: join(paths.profileDir, workerStateDirName(toolId)) };
}
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { paths, selected, sourceId, stateDir, toolId } = await workerContext(options);
  configureLogger({ logsDir: join(paths.logsDir, 'worker') });
  const larkChannel = { profile: paths.profile, rootDir: paths.rootDir, configPath: paths.configFile,
    larkCliConfigDir: paths.larkCliConfigDir, larkCliSourceConfigFile: paths.larkCliSourceConfigFile };
  if (toolId !== 'claude' && toolId !== 'zcode') throw new Error(`Worker adapter not registered: ${toolId}`);
  const agent = toolId === 'zcode' ? new ZcodeAdapter({ binary: selected.zcode?.binaryPath, args: selected.zcode?.args, dataDir: selected.zcode?.dataDir, larkChannel }) : new ClaudeAdapter({ binary: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude',
    larkChannel: { profile: paths.profile, rootDir: paths.rootDir, configPath: paths.configFile,
      larkCliConfigDir: paths.larkCliConfigDir, larkCliSourceConfigFile: paths.larkCliSourceConfigFile } });
  const worker = await startWorkerServer({ stateDir, agent, sourceId, botAppId: selected.accounts.app.id,
    maxConcurrent: getMaxConcurrentRuns({ preferences: selected.preferences } as Parameters<typeof getMaxConcurrentRuns>[0]) });
  console.log(`${toolDefinition(toolId).label} execution worker ready (${paths.profile})`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void worker.close().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
export async function workerService(action: 'start' | 'stop' | 'status', options: WorkerOptions): Promise<void> {
  const { paths, selected, sourceId, stateDir, toolId } = await workerContext(options);
  const name = toolId === 'claude' ? `lark-channel-worker.${paths.profile}.service` : `lark-channel-worker.${toolId}.${paths.profile}.service`;
  if (action === 'status') {
    const client = new WorkerClient(stateDir, sourceId, selected.accounts.app.id, toolId);
    await client.health();
    console.log(`${toolDefinition(toolId).label} execution worker running (${paths.profile})`); return;
  }
  if (process.platform !== 'linux') throw new Error('Worker service management currently requires Linux systemd; use worker run under an independent supervisor on other platforms.');
  const systemctl = (args: string[]) => {
    const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'systemctl failed');
  };
  if (action === 'stop') { systemctl(['stop', name]); console.log(`Worker stopped (${paths.profile}); ${toolDefinition(toolId).label} tasks were stopped.`); return; }
  // Starting is idempotent. Routine bridge deployments must not bounce this unit.
  const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', name]);
  if (active.status !== 0) {
    const unit = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', name);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, buildWorkerUnit({ node: process.execPath, entry: process.argv[1]!, profile: paths.profile,
      config: paths.configFile, envPath: process.env.PATH ?? '', toolId, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, binary: process.env.LARK_CHANNEL_CLAUDE_BIN, zcodeBinary: process.env.LARK_CHANNEL_ZCODE_BIN, zcodeDataDir: toolId === 'zcode' ? sourceId : undefined }), 'utf8');
    systemctl(['daemon-reload']); systemctl(['enable', '--now', name]);
  }
  const client = new WorkerClient(stateDir, sourceId, selected.accounts.app.id, toolId);
  const deadline = Date.now() + 10_000;
  do {
    try { await client.health(); console.log(`${toolDefinition(toolId).label} execution worker ready (${paths.profile})`); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Worker did not become ready; inspect systemctl --user status ${name}`);
}
