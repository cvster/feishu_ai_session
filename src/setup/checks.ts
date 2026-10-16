import { zcodeStorageDir } from '../agent/zcode/client';
import { zcodeCommand } from '../agent/zcode/client';
import { workerStateDirName, type ToolId } from '../tools/definitions';
import { createRequire } from 'node:module';
import { access, constants, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnProcess } from '../platform/spawn';
import { resolveCodexBinary } from '../platform/codex-binary';
import { resolveSharedCodexEndpoint } from '../../packages/codex-core/src/queue';
import { CodexThreadReader } from '../session/codex-thread-reader';
import { WorkerClient } from '../worker/client';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, readActiveProfile, runtimeProfileConfig } from '../config/profile-store';
import { loadRuntimeEnv } from '../config/runtime-env';
import { resolveAppSecret } from '../config/secret-resolver';
import { createLarkChannel } from '@larksuite/channel';
import { createDirectLarkHttpInstance } from '../platform/lark-http';
import pkg from '../../package.json';

// Project support floor, not the date these features first appeared upstream.
// Always check capabilities too: a version string alone proves very little.
export const SUPPORTED = { codex: '0.159.2', claude: '2.1.261', lark: '1.0.97', pnpm: '10.33.0', node: '20.12.0' };
export type Agents = 'auto' | ToolId | 'both';
export interface ProbeResult { ok: boolean; output: string }
export type Probe = (command: string, args: string[]) => Promise<ProbeResult>;
export interface Check { id: string; status: 'pass' | 'warn' | 'fail'; detail: string; fix?: string }
export interface DoctorOptions { agents?: string; profile?: string; config?: string; workspace?: string; runtime?: boolean; network?: boolean; json?: boolean }
export function versionOf(output: string): string | undefined { return /\b(\d+\.\d+\.\d+)(?!\d)/.exec(output)?.[1]; }
export function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i]! > b[i]!) return true; if (a[i]! < b[i]!) return false; }
  return true;
}
export const probe: Probe = (command, args) => new Promise(resolveProbe => {
  let text = '', done = false;
  const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); resolveProbe({ ok, output: text }); };
  const timer = setTimeout(() => { child.kill('SIGTERM'); finish(false); }, 12_000);
  const read = (chunk: Buffer) => { text = (text + chunk.toString('utf8')).slice(-128_000); };
  child.stdout?.on('data', read); child.stderr?.on('data', read);
  child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0));
});
export async function checkTool(kind: 'codex' | 'claude', binary: string, run: Probe = probe): Promise<Check[]> {
  const version = await run(binary, ['--version']), parsed = versionOf(version.output);
  if (!version.ok || !parsed) return [{ id: kind, status: 'fail', detail: `${kind} 未安装、不可执行或无法读取版本`, fix: `安装 ${kind} ${SUPPORTED[kind]} 或更高版本，并检查 PATH/二进制路径` }];
  const rows: Check[] = [{ id: `${kind}.version`, status: atLeast(parsed, SUPPORTED[kind]) ? 'pass' : 'fail', detail: `${kind} ${parsed}；本项目支持基线 >= ${SUPPORTED[kind]}`, fix: atLeast(parsed, SUPPORTED[kind]) ? undefined : '升级选中的 CLI；安装脚本不会偷偷替换已安装的版本' }];
  const args = kind === 'codex' ? ['queue', '--help'] : ['--help'];
  const help = await run(binary, args);
  const flags = kind === 'codex' ? ['--thread', '--message', '--remote'] : ['--output-format', 'stream-json', '--permission-mode', '--session-id', '--name', '--effort'];
  const missing = flags.filter(flag => !help.output.includes(flag));
  rows.push({ id: `${kind}.capabilities`, status: help.ok && !missing.length ? 'pass' : 'fail', detail: missing.length ? `缺少能力：${missing.join(', ')}` : '桥接所需命令与可见参数可用', fix: '检查是否误用了旧 CLI、同名程序或不兼容发行版；不要只修改版本字符串' });
  if (kind === 'codex') {
    const server = await run(binary, ['app-server', '--help']);
    rows.push({ id: 'codex.app-server', status: server.ok && server.output.includes('--listen') ? 'pass' : 'fail', detail: '检查公开 app-server 入口及 listen 参数', fix: '安装本项目支持的 Codex CLI' });
  }
  return rows;
}
export async function collectChecks(options: DoctorOptions, run: Probe = probe): Promise<Check[]> {
  const rows: Check[] = [], requested = options.agents ?? 'auto';
  if (!['auto', 'codex', 'claude', 'zcode', 'both'].includes(requested)) throw new Error('--agents 仅支持 auto、codex、claude、zcode、both');
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir);
  if (profile) await loadRuntimeEnv(profile, rootDir);
  const paths = resolveAppPaths({ rootDir, profile: profile ?? 'codex' });
  const root = await loadRootConfig(paths.configFile), selected = profile ? root?.profiles[profile] : undefined;
  const phaseStatus = options.runtime ? 'fail' : 'warn';
  rows.push({ id: 'node', status: atLeast(process.versions.node, SUPPORTED.node) ? 'pass' : 'fail', detail: `Node ${process.versions.node}；要求 >= ${SUPPORTED.node}，推荐 24` });
  for (const command of ['git', 'npm', 'pnpm']) {
    if (options.runtime && command !== 'git') continue;
    const result = await run(command, ['--version']), version = versionOf(result.output);
    rows.push({ id: command, status: result.ok && (command !== 'pnpm' || version === SUPPORTED.pnpm) ? 'pass' : 'fail', detail: result.ok ? `${command} ${version ?? '可用'}` : `${command} 不可用`, fix: command === 'pnpm' ? '使用安装脚本安装固定 pnpm 10.33.0，不要求 Corepack' : `安装 ${command} 并检查 PATH` });
  }
  const require = createRequire(import.meta.url);
  for (const dependency of Object.keys(pkg.dependencies)) {
    try { require.resolve(dependency); rows.push({ id: `dependency.${dependency}`, status: 'pass', detail: `${dependency} 可解析` }); }
    catch { rows.push({ id: `dependency.${dependency}`, status: 'fail', detail: `${dependency} 缺失`, fix: '源码目录执行 pnpm install --frozen-lockfile；产物部署按安装文档安装生产依赖' }); }
  }
  if (!options.runtime) {
    for (const tool of ['tsup', 'tsc']) {
      const result = await run('pnpm', ['exec', tool, '--version']);
      rows.push({ id: `build.${tool}`, status: result.ok ? 'pass' : 'fail', detail: `${tool} 构建工具${result.ok ? '可用' : '缺失'}`, fix: '构建源码需安装开发依赖，不要使用 --prod' });
    }
  }
  const lark = await run('lark-cli', ['--version']), larkVersion = versionOf(lark.output);
  rows.push({ id: 'lark-cli', status: lark.ok && larkVersion && atLeast(larkVersion, SUPPORTED.lark) ? 'pass' : 'fail', detail: `飞书 CLI ${larkVersion ?? '缺失'}；基线 >= ${SUPPORTED.lark}`, fix: `npm install -g @larksuite/cli@${SUPPORTED.lark}` });
  const codexBinary = resolveCodexBinary(selected?.codex?.binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex');
  const claudeBinary = process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude';
  const available = { codex: await run(codexBinary, ['--version']), claude: await run(claudeBinary, ['--version']) };
  const kinds: ToolId[] = requested === 'both' ? ['codex', 'claude'] : requested !== 'auto' ? [requested as ToolId] :
    selected ? [selected.agentKind] : (['codex', 'claude'] as const).filter(kind => available[kind].ok);
  if (!kinds.length) rows.push({ id: 'agents', status: 'fail', detail: '至少需要 Codex 或 Claude 之一', fix: '运行安装脚本 --agents codex、claude 或 both' });
  for (const kind of kinds) {
    if (kind === 'zcode') {
      const command = zcodeCommand({ binary: selected?.zcode?.binaryPath, args: selected?.zcode?.args });
      const version = await run(command.binary, [...command.args, '--version']);
      const help = await run(command.binary, [...command.args, '--help']);
      rows.push({ id: 'zcode.capabilities', status: version.ok && help.ok && ['app-server', '--resume', '--mode'].every(flag => help.output.includes(flag)) ? 'pass' : 'fail', detail: 'ZCode Agent CLI 版本与 app-server/恢复/权限入口检查（不启动任务）' });
      rows.push({ id: 'zcode.auth', status: 'warn', detail: 'ZCode 的会话列表不证明模型已授权；请先在同一 CLI 完成登录和简单问答', fix: '配置本机 CLI 的模型与账号并验证问答，见 docs/ZCODE.md；不将凭据写入桥接仓库' });
      if (options.runtime && selected) {
        const source = zcodeStorageDir(selected.zcode);
        try { await new WorkerClient(join(paths.profileDir, workerStateDirName('zcode')), source, selected.accounts.app.id, 'zcode').health(); rows.push({ id: 'zcode.worker', status: 'pass', detail: 'ZCode worker 身份和来源匹配' }); }
        catch { rows.push({ id: 'zcode.worker', status: 'fail', detail: 'ZCode worker 未就绪', fix: `worker start --tool zcode --profile ${profile}` }); }
      }
      continue;
    }
    const binary = kind === 'codex' ? codexBinary : claudeBinary;
    rows.push(...await checkTool(kind, binary, run));
    const auth = await run(binary, kind === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']);
    let authenticated = auth.ok;
    if (kind === 'claude') { try { authenticated = auth.ok && JSON.parse(auth.output).loggedIn === true; } catch { authenticated = false; } }
    rows.push({ id: `${kind}.auth`, status: authenticated ? 'pass' : phaseStatus, detail: authenticated ? `${kind} 登录状态命令通过（不代表额度或模型可用）` : `${kind} 未确认登录`, fix: kind === 'codex' ? '运行 codex login；如使用自定义提供方，核对其认证配置' : '运行 claude auth login；第三方提供方核对对应账号配置与 runtime.env' });
    if (!options.runtime) continue;
    if (kind === 'codex') {
      const home = selected?.codex?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
      const remote = await resolveSharedCodexEndpoint({ codexHome: home, remote: process.env.CODEX_QUEUE_REMOTE });
      if (!remote) rows.push({ id: 'codex.writer', status: 'fail', detail: '没有发现公开共享 Codex writer', fix: '启动兼容的 Codex app-server daemon 或桌面共享端点；详见 docs/INSTALL.md，不要把历史读取进程当执行服务' });
      else {
        const reader = new CodexThreadReader({ binary, profileStateDir: paths.profileDir, codexHome: home, inheritCodexHome: true, sharedServer: true, passive: true, remote, timeoutMs: 5000 });
        try { await reader.connect(); await reader.rpc('account/read', {}); rows.push({ id: 'codex.writer', status: 'pass', detail: '公开 writer 连接和只读 RPC 通过，未提交任务' }); }
        catch { rows.push({ id: 'codex.writer', status: 'fail', detail: '公开 writer 无法连接或只读 RPC 不兼容', fix: '核对 CODEX_HOME、CODEX_QUEUE_REMOTE、认证和 CLI 版本；不自动启动或重启 writer' }); }
        finally { await reader.stop(); }
      }
    } else if (selected) {
      const sourceId = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
      try { await new WorkerClient(join(paths.profileDir, 'execution-worker'), sourceId, selected.accounts.app.id).health(); rows.push({ id: 'claude.worker', status: 'pass', detail: '独立 worker 健康，应用及账号目录匹配' }); }
      catch { rows.push({ id: 'claude.worker', status: 'fail', detail: '独立 worker 未运行或身份/目录不匹配', fix: `执行 worker start --profile ${profile}（Linux）；其他平台用 worker run 配合进程托管` }); }
    }
  }
  const workspace = options.workspace ?? selected?.workspaces.default;
  if (workspace) {
    try { const { resolveWorkingDirectory } = await import('../policy/workspace'); const result = await resolveWorkingDirectory(workspace); if (!result.ok) throw new Error(); await access(result.cwdRealpath, constants.R_OK | constants.W_OK); rows.push({ id: 'workspace', status: 'pass', detail: '项目目录存在且可读写' }); }
    catch { rows.push({ id: 'workspace', status: 'fail', detail: '项目目录不存在、范围过大或无访问权限', fix: '使用自己的项目绝对路径，避免根目录、Home 根或旧机器路径' }); }
  } else rows.push({ id: 'workspace', status: phaseStatus, detail: '尚未配置项目目录', fix: '创建 profile 时传 --workspace，或配置 workspaces.default' });
  rows.push({ id: 'profile', status: selected ? 'pass' : phaseStatus, detail: selected ? `profile ${profile} 已配置` : '尚未创建或找不到 profile', fix: '执行 profile create <名称> --agent codex|claude --workspace <目录>' });
  if (selected) {
    try {
      const privateCli = JSON.parse(await readFile(paths.larkCliTargetConfigFile, 'utf8'));
      if (!privateCli.apps?.some((app: { appId?: string; brand?: string }) => app.appId === selected.accounts.app.id && app.brand === selected.accounts.app.tenant)) throw new Error();
      rows.push({ id: 'lark-cli.binding', status: 'pass', detail: 'profile 飞书 CLI 的应用/租户与桥接匹配' });
    } catch { rows.push({ id: 'lark-cli.binding', status: phaseStatus, detail: 'profile 飞书 CLI 未绑定或应用不匹配', fix: `执行 setup --profile ${profile}；不会改绑其他 profile` }); }
  }
  if (process.platform === 'linux') {
    const manager = await run('systemctl', ['--user', 'show-environment']);
    rows.push({ id: 'service-manager', status: manager.ok ? 'pass' : 'warn', detail: manager.ok ? '用户级 systemd 可访问' : '用户级 systemd 不可用（容器、WSL 或无用户会话常见）', fix: '前台运行 run/worker run，或配置用户级 systemd；退出登录保活需管理员开启 linger' });
  } else if (kinds.includes('claude')) rows.push({ id: 'service-manager', status: 'warn', detail: 'Claude worker start 目前仅支持 Linux；worker run 可用', fix: '在 macOS/Windows 用独立终端或自己的进程管理器托管 worker run' });
  if (selected && options.network) {
    try {
      const cfg = runtimeProfileConfig(root!, profile!);
      const secret = await resolveAppSecret(cfg, paths);
      const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
      const useProxy = process.env.LARK_CHANNEL_FEISHU_USE_PROXY === '1';
      const channel = createLarkChannel({ appId: selected.accounts.app.id, appSecret: secret, domain: selected.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn', logger: quiet, httpInstance: useProxy ? undefined : createDirectLarkHttpInstance(8000), respectProxyEnv: useProxy });
      const info = await channel.getAppInfo({ userIdType: 'open_id' });
      if (!info.ownerId) throw new Error();
      rows.push({ id: 'feishu.credentials', status: 'pass', detail: '飞书网络、应用凭据和应用所有者读取通过；未发消息、未建立事件长连接' });
    } catch { rows.push({ id: 'feishu.credentials', status: 'fail', detail: '飞书网络、应用凭据或应用信息权限验证失败', fix: '核对 App ID/Secret、网络和 application:application:self_manage；不输出接口原文以免泄露凭据' }); }
  }
  rows.push({ id: 'feishu.release', status: 'warn', detail: '权限清单、事件订阅、卡片回调、应用发布和可用范围仍需按文档验收；不把本地检查当成端到端成功', fix: '见 docs/FEISHU_PERMISSIONS.md 和 docs/INSTALL.md 的收发/附件/按钮验收' });
  return rows;
}
export async function runDoctor(options: DoctorOptions): Promise<void> {
  const checks = await collectChecks(options);
  const ok = !checks.some(row => row.status === 'fail');
  if (options.json) console.log(JSON.stringify({ ok, phase: options.runtime ? 'runtime' : 'install', checks }, null, 2));
  else for (const row of checks) console.log(`${row.status === 'pass' ? '✓' : row.status === 'warn' ? '!' : '✗'} ${row.id}: ${row.detail}${row.status !== 'pass' && row.fix ? `\n  → ${row.fix}` : ''}`);
  if (!ok) process.exitCode = 1;
}
