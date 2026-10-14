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

interface WorkerOptions { profile?: string; config?: string }
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
export function buildWorkerUnit(inputs: { node: string; entry: string; profile: string; config: string; envPath: string; claudeConfigDir?: string; binary?: string }): string {
  return `[Unit]
Description=Lark independent Claude execution worker (${inputs.profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quote(inputs.node)} ${quote(inputs.entry)} worker run --profile ${quote(inputs.profile)} --config ${quote(inputs.config)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
Environment=${quote(`PATH=${inputs.envPath}`)}
${inputs.claudeConfigDir ? `Environment=${quote(`CLAUDE_CONFIG_DIR=${inputs.claudeConfigDir}`)}\n` : ''}${inputs.binary ? `Environment=${quote(`LARK_CHANNEL_CLAUDE_BIN=${inputs.binary}`)}\n` : ''}
[Install]
WantedBy=default.target
`;
}
async function workerContext(options: WorkerOptions) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? 'codex';
  const paths = resolveAppPaths({ profile, rootDir });
  const config = await loadRootConfig(paths.configFile);
  const selected = config?.profiles[profile];
  if (!selected) throw new Error(`profile not found: ${profile}`);
  const sourceId = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  return { paths, selected, sourceId, stateDir: join(paths.profileDir, 'execution-worker') };
}
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { paths, selected, sourceId, stateDir } = await workerContext(options);
  configureLogger({ logsDir: join(paths.logsDir, 'worker') });
  const agent = new ClaudeAdapter({ binary: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude',
    larkChannel: { profile: paths.profile, rootDir: paths.rootDir, configPath: paths.configFile,
      larkCliConfigDir: paths.larkCliConfigDir, larkCliSourceConfigFile: paths.larkCliSourceConfigFile } });
  const worker = await startWorkerServer({ stateDir, agent, sourceId, botAppId: selected.accounts.app.id,
    maxConcurrent: getMaxConcurrentRuns({ preferences: selected.preferences } as Parameters<typeof getMaxConcurrentRuns>[0]) });
  console.log(`Claude execution worker ready (${paths.profile})`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void worker.close().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
export async function workerService(action: 'start' | 'stop' | 'status', options: WorkerOptions): Promise<void> {
  const { paths, selected, sourceId, stateDir } = await workerContext(options);
  const name = `lark-channel-worker.${paths.profile}.service`;
  if (action === 'status') {
    const client = new WorkerClient(stateDir, sourceId, selected.accounts.app.id);
    await client.health();
    console.log(`Claude execution worker running (${paths.profile})`); return;
  }
  if (process.platform !== 'linux') throw new Error('Worker service management currently requires Linux systemd; use worker run under an independent supervisor on other platforms.');
  const systemctl = (args: string[]) => {
    const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'systemctl failed');
  };
  if (action === 'stop') { systemctl(['stop', name]); console.log(`Worker stopped (${paths.profile}); active Claude tasks were stopped.`); return; }
  // Starting is idempotent. Routine bridge deployments must not bounce this unit.
  const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', name]);
  if (active.status !== 0) {
    const unit = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', name);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, buildWorkerUnit({ node: process.execPath, entry: process.argv[1]!, profile: paths.profile,
      config: paths.configFile, envPath: process.env.PATH ?? '', claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, binary: process.env.LARK_CHANNEL_CLAUDE_BIN }), 'utf8');
    systemctl(['daemon-reload']); systemctl(['enable', '--now', name]);
  }
  const client = new WorkerClient(stateDir, sourceId, selected.accounts.app.id);
  const deadline = Date.now() + 10_000;
  do {
    try { await client.health(); console.log(`Claude execution worker ready (${paths.profile})`); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Worker did not become ready; inspect systemctl --user status ${name}`);
}
