import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

export const VERSIONS = { pnpm: '10.33.0', codex: '0.159.2', claude: '2.1.261', lark: '1.0.97' };
export function envLine(name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${name} 包含换行，请手动配置 runtime.env`);
  // Node dotenv does not JSON-decode backslashes. Single quotes preserve Windows paths.
  if (value.includes("'")) throw new Error(`${name} 包含单引号，请手动配置 runtime.env`);
  return `${name}='${value}'\n`;
}
export function installerArgs(args) {
  const { values } = parseArgs({ args, options: {
    agents: { type: 'string', default: 'auto' }, profile: { type: 'string', default: 'my-bot' },
    workspace: { type: 'string' }, configure: { type: 'boolean' }, start: { type: 'boolean' },
    'install-clis': { type: 'boolean' }, 'skip-tests': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!['auto', 'codex', 'claude', 'both'].includes(values.agents)) throw new Error('--agents 只能为 auto、codex、claude、both');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.profile)) throw new Error('profile 名称无效');
  if (values.start && !values.configure) throw new Error('--start 需同时提供 --configure；不会启动或重启已有服务');
  if (values.configure && !values.workspace) throw new Error('--configure 需要 --workspace 本机项目目录');
  return values;
}
export async function install(args = process.argv.slice(2)) {
  const opts = installerArgs(args);
  if (opts.help) { console.log(`用法：node tools/install.mjs --agents codex|claude|both [选项]
  --agents auto      自动使用已安装的 Codex/Claude；一个都没有时需明确选择
  --install-clis     在用户工具目录安装缺失/过旧的 CLI，不覆盖原安装
  --configure       构建后创建新 profile（需要扫码/交互输入应用凭据）
  --profile my-bot   新 profile 名称
  --workspace PATH  本机项目目录，配合 --configure 使用
  --start           新 profile 配置、运行检查通过后启动服务；不重启已有服务
  --skip-tests      跳过测试，仍执行类型检查和构建
Node.js >=20.12（推荐24）和 Git 需预装。默认不登录、不启动模型任务、不改已有 profile。`); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 12)) throw new Error('需要 Node.js >=20.12，推荐 Node 24');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
  // Before dependencies exist, only fixed command names/argument arrays are used.
  // Windows npm.cmd is launched through npm's JS entry, never a shell string.
  const require = createRequire(import.meta.url);
  const npmCandidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let npmEntry;
  for (const candidate of npmCandidates) { try { npmEntry = require.resolve(candidate); break; } catch {} }
  const invoke = (command, argv, stdio = 'inherit') => {
    if (command === 'npm' && npmEntry) { argv = [npmEntry, ...argv]; command = process.execPath; }
    const result = spawnSync(command, argv, { stdio, encoding: 'utf8', windowsHide: true, env: process.env });
    if (result.error || result.status !== 0) throw new Error(`${command === process.execPath ? 'Node/npm' : command} 执行失败；请核对安装与网络，详见 docs/INSTALL.md`);
    return result;
  };
  invoke('git', ['--version']); invoke('npm', ['--version']);
  const tools = resolve(process.env.CODEXFEISHU_TOOLS_DIR ?? join(homedir(), '.local', 'share', 'codexfeishu-tools'));
  await mkdir(tools, { recursive: true, mode: 0o700 });
  // Pin pnpm locally instead of requiring Corepack or global administrator access.
  let pnpm = join(tools, 'node_modules/pnpm/bin/pnpm.cjs');
  try { if (JSON.parse(await readFile(join(tools, 'node_modules/pnpm/package.json'), 'utf8')).version !== VERSIONS.pnpm) throw new Error(); }
  catch { invoke('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `pnpm@${VERSIONS.pnpm}`]); }
  const runPnpm = argv => invoke(process.execPath, [pnpm, ...argv]);
  const cliPaths = [join(tools, 'node_modules', '.bin'), join(homedir(), '.local', 'bin')];
  process.env.PATH = [...cliPaths, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':');
  // cross-spawn handles native binaries and .cmd shims without concatenating arguments.
  runPnpm(['install', '--frozen-lockfile']);
  const crossSpawn = require('cross-spawn');
  const has = command => crossSpawn.sync(command, ['--version'], { stdio: 'ignore', timeout: 10_000, env: process.env }).status === 0;
  let kinds = opts.agents === 'both' ? ['codex', 'claude'] : opts.agents !== 'auto' ? [opts.agents] : ['codex', 'claude'].filter(has);
  if (!kinds.length) throw new Error('未发现编程助手。请指定 --agents codex、claude 或 both；如需脚本安装 CLI，再加 --install-clis');
  const packages = { codex: `@openai/codex@${VERSIONS.codex}`, claude: `@anthropic-ai/claude-code@${VERSIONS.claude}`, 'lark-cli': `@larksuite/cli@${VERSIONS.lark}` };
  const minimums = { codex: VERSIONS.codex, claude: VERSIONS.claude, 'lark-cli': VERSIONS.lark };
  const missing = [...kinds, 'lark-cli'].filter(kind => {
    const result = crossSpawn.sync(kind, ['--version'], { encoding: 'utf8', timeout: 10_000, env: process.env });
    const version = /\b(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.status !== 0 || !version) return true;
    const current = version.slice(1).map(Number), wanted = minimums[kind].split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (current[i] !== wanted[i]) return current[i] < wanted[i]; }
    return false;
  });
  if (missing.length && !opts['install-clis']) throw new Error(`缺少 ${missing.join(', ')}。重新加 --install-clis 可安装到用户工具目录，不需要 sudo`);
  for (const kind of missing) invoke('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund', '--save-exact', packages[kind]]);
  runPnpm(['typecheck']);
  if (!opts['skip-tests']) runPnpm(['test']);
  runPnpm(['build']);
  const cli = argv => invoke(process.execPath, ['bin/lark-channel-bridge.mjs', ...argv]);
  const selection = kinds.length === 2 ? 'both' : kinds[0];
  cli(['doctor', '--agents', selection, ...(opts.workspace ? ['--workspace', resolve(opts.workspace)] : [])]);
  console.log(`\n工具目录：${tools}\n以后手动运行前，把 ${cliPaths[0]} 加入 PATH（不要将 Node/npm 的环境变量值复制给别人）。`);
  if (!opts.configure) { console.log('安装和构建完成。下一步按 docs/INSTALL.md 登录所选 CLI、创建 profile 和配置飞书。'); return; }
  if (!opts.workspace) throw new Error('--configure 需要 --workspace 项目绝对路径');
  cli(['profile', 'create', opts.profile, '--agent', kinds[0], '--workspace', resolve(opts.workspace)]);
  // Persist only non-secret tool paths; API keys/proxies remain explicit local config.
  const channelHome = process.env.LARK_CHANNEL_HOME ?? join(homedir(), '.lark-channel');
  const envPath = join(channelHome, 'profiles', opts.profile, 'runtime.env');
  const { writeFile } = await import('node:fs/promises');
  try { await writeFile(envPath, `# Shared bridge/worker environment; values are literal, no shell expansion.\n${envLine('PATH', process.env.PATH)}`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  cli(['setup', '--profile', opts.profile]);
  if (!opts.start) { console.log('profile 已创建。请按 docs/INSTALL.md 完成登录、worker/writer 和飞书发布，再执行 doctor --runtime --network。'); return; }
  if (kinds.includes('claude')) {
    if (process.platform !== 'linux') throw new Error('此平台需手动托管 worker run，脚本未启动桥接；详见 docs/INSTALL.md');
    cli(['worker', 'start', '--profile', opts.profile]);
  }
  cli(['doctor', '--profile', opts.profile, '--agents', selection, '--runtime', '--network']);
  cli(['start', '--profile', opts.profile]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) install().catch(error => { console.error(`安装未完成：${error.message}`); process.exitCode = 1; });
