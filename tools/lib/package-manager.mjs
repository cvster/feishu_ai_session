import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const PNPM_VERSION = '10.33.0';

/** Invoke npm through Node, including on Windows; no shell command interpolation. */
export function npmCommand(args, env = process.env) {
  const require = createRequire(import.meta.url);
  for (const file of [env.npm_execpath?.endsWith('npm-cli.js') ? env.npm_execpath : undefined, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
    try { return { command: process.execPath, args: [require.resolve(file), ...args] }; } catch {}
  }
  if (process.platform === 'win32') throw new Error('未找到 npm，请安装含 npm 的 Node.js 24');
  return { command: 'npm', args };
}

/** Shared by install/deploy: a pinned user-local pnpm, without global installs or Corepack. */
export async function ensurePnpm(directory, env = process.env) {
  const tools = resolve(directory ?? env.CODEXFEISHU_TOOLS_DIR ?? join(homedir(), '.local/share/codexfeishu-tools'));
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const entry = join(tools, 'node_modules/pnpm/bin/pnpm.cjs');
  try {
    if (JSON.parse(await readFile(join(tools, 'node_modules/pnpm/package.json'), 'utf8')).version !== PNPM_VERSION) throw new Error();
  } catch {
    const npm = npmCommand(['install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `pnpm@${PNPM_VERSION}`], env);
    const result = spawnSync(npm.command, npm.args, { env, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('用户目录 pnpm 安装失败，请检查 Node/npm 和网络；详见 docs/INSTALL.md');
  }
  return { entry, env: { ...env, PATH: [join(tools, 'node_modules/.bin'), dirname(process.execPath), env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':') } };
}
