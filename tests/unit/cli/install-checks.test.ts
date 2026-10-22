import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { atLeast, checkTool, collectChecks, type Probe, SUPPORTED, versionOf } from '../../../src/setup/checks';
import { loadRuntimeEnv } from '../../../src/config/runtime-env';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
async function temp() { const root = await mkdtemp(join(tmpdir(), 'bridge-install-')); roots.push(root); return root; }
const healthyProbe: Probe = async (command, args) => {
  if (command.includes('codex')) {
    if (args[0] === '--version') return { ok: true, output: `codex-cli ${SUPPORTED.codex}` };
    if (args[0] === 'login') return { ok: true, output: 'Logged in; secret-value-must-not-appear' };
    return { ok: true, output: '--thread --message --remote --listen' };
  }
  if (command === 'claude') return { ok: false, output: '' };
  if (command === 'lark-cli') return { ok: true, output: `lark-cli version ${SUPPORTED.lark}` };
  return { ok: true, output: '10.33.0' };
};
describe('installation checks', () => {
  it('uses canonical worker binaries without changing root or worker configuration during diagnostics', async () => {
    const root = await temp(), config = join(root, 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } }, codex: { binaryPath: '/obsolete/codex' } });
    const rootText = JSON.stringify(createRootConfig('test', profile)); await writeFile(config, rootText);
    const directory = join(root, 'profiles', 'test', 'workers', 'codex'); await mkdir(directory, { recursive: true });
    const canonicalBinary = join(root, 'codex'); await writeFile(canonicalBinary, 'fixture', { mode: 0o700 });
    const workerFile = join(directory, 'config.json'), workerText = JSON.stringify({ version: 1, toolId: 'codex', options: { binaryPath: canonicalBinary } });
    await writeFile(workerFile, workerText);
    const run = vi.fn(healthyProbe);
    await collectChecks({ config, profile: 'test', agents: 'codex' }, run);
    expect(run).toHaveBeenCalledWith(canonicalBinary, ['queue', '--help']);
    expect(run.mock.calls.some(([binary]) => binary === '/obsolete/codex')).toBe(false);
    expect(await readFile(config, 'utf8')).toBe(rootText);
    expect(await readFile(workerFile, 'utf8')).toBe(workerText);
  });
  it('uses numeric version comparisons and handles CLI version banners', () => {
    expect(versionOf('codex-cli 0.159.2')).toBe('0.159.2');
    expect(versionOf('2.1.261 (Claude Code)')).toBe('2.1.261');
    expect(atLeast('0.160.0', '0.159.2')).toBe(true);
    expect(atLeast('2.1.99', '2.1.261')).toBe(false);
  });
  it('rejects a high version that lacks the queue protocol instead of passing by version alone', async () => {
    const rows = await checkTool('codex', 'codex', async (_binary, args) => ({ ok: true, output: args[0] === '--version' ? 'codex-cli 99.0.0' : 'unrelated command' }));
    expect(rows.find(row => row.id === 'codex.version')?.status).toBe('pass');
    expect(rows.find(row => row.id === 'codex.capabilities')?.status).toBe('fail');
    expect(rows.find(row => row.id === 'codex.app-server')?.status).toBe('fail');
  });
  it('requires no Claude when only Codex is selected and does not leak login output', async () => {
    vi.stubEnv('LARK_CHANNEL_HOME', await temp());
    vi.stubEnv('LARK_CHANNEL_CODEX_BIN', 'codex');
    const rows = await collectChecks({ agents: 'codex' }, healthyProbe);
    expect(rows.some(row => row.status === 'fail')).toBe(false);
    expect(rows.some(row => row.id.startsWith('claude'))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('secret-value-must-not-appear');
    const both = await collectChecks({ agents: 'both' }, healthyProbe);
    expect(both.find(row => row.id === 'claude')?.status).toBe('fail');
  });
  it('lets Claude be the only installed agent', async () => {
    vi.stubEnv('LARK_CHANNEL_HOME', await temp());
    const run: Probe = async (binary, args) => {
      if (binary.includes('codex')) return { ok: false, output: '' };
      if (binary === 'claude') return { ok: true, output: args[0] === '--version' ? `claude ${SUPPORTED.claude}` : args[0] === 'auth' ? '{"loggedIn":true}' : '--output-format stream-json --permission-mode --session-id --name --effort' };
      return healthyProbe(binary, args);
    };
    const rows = await collectChecks({ agents: 'claude' }, run);
    expect(rows.some(row => row.status === 'fail')).toBe(false);
    expect(rows.some(row => row.id.startsWith('codex'))).toBe(false);
  });
  it('does not mistake successful version checks for authenticated runtime readiness', async () => {
    vi.stubEnv('LARK_CHANNEL_HOME', await temp());
    vi.stubEnv('LARK_CHANNEL_CODEX_BIN', 'codex');
    vi.stubEnv('CODEX_HOME', join(await temp(), 'absent-codex'));
    vi.stubEnv('CODEX_QUEUE_REMOTE', '');
    const run: Probe = async (binary, args) => args[0] === 'login' ? { ok: false, output: 'private-auth-error' } : healthyProbe(binary, args);
    const install = await collectChecks({ agents: 'codex' }, run);
    expect(install.find(row => row.id === 'codex.auth')?.status).toBe('warn');
    const runtime = await collectChecks({ agents: 'codex', runtime: true }, run);
    expect(runtime.find(row => row.id === 'codex.auth')?.status).toBe('fail');
    expect(runtime.find(row => row.id === 'profile')?.status).toBe('fail');
    expect(runtime.find(row => row.id === 'codex.writer')?.status).toBe('fail');
    expect(JSON.stringify(runtime)).not.toContain('private-auth-error');
  });
});
describe('shared runtime environment', () => {
  it('loads literal private profile settings for either process without running shell input', async () => {
    const root = await temp(), directory = join(root, 'profiles', 'test'); await mkdir(directory, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'old'); vi.stubEnv('OPENAI_API_KEY', 'old');
    await writeFile(join(directory, 'runtime.env'), "CLAUDE_CONFIG_DIR='/new/claude'\nOPENAI_API_KEY='$(touch /must-not-execute)'\n", { mode: 0o600 });
    await loadRuntimeEnv('test', root);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/new/claude');
    expect(process.env.OPENAI_API_KEY).toBe('$(touch /must-not-execute)');
  });
  it('refuses public secrets and partial changes from forbidden settings', async () => {
    const root = await temp(), directory = join(root, 'profiles', 'test'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'runtime.env');
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'unchanged');
    await writeFile(path, 'CLAUDE_CONFIG_DIR=new\nHOME=/other/home\n', { mode: 0o600 });
    await expect(loadRuntimeEnv('test', root)).rejects.toThrow('HOME');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('unchanged');
    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises'); await chmod(path, 0o644);
      await expect(loadRuntimeEnv('test', root)).rejects.toThrow('chmod 600');
    }
  });
  it('validates installer choices and preserves Windows backslashes in runtime.env', async () => {
    const { installerArgs, envLine, VERSIONS } = await import(new URL('../../../tools/install.mjs', import.meta.url).href);
    for (const key of ['pnpm', 'codex', 'claude', 'lark'] as const) expect(VERSIONS[key]).toBe(SUPPORTED[key]);
    expect(installerArgs(['--agents', 'claude']).agents).toBe('claude');
    expect(() => installerArgs(['--agents', 'unknown'])).toThrow();
    expect(() => installerArgs(['--start'])).toThrow('--configure');
    const path = 'C:\\Users\\Me\\node;C:\\tools\\bin';
    expect(parseEnv(envLine('PATH', path)).PATH).toBe(path);
    expect(() => envLine('PATH', 'a\nb')).toThrow();
  });
});
