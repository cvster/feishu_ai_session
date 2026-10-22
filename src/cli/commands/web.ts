import { dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { configureWeb, loadWebConfig } from '../../web/config';
import { writeFileAtomic } from '../../platform/atomic-write';
export async function runWeb(action: 'configure' | 'status' | 'disable', options: { profile?: string; config?: string; host?: string; port?: string }) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? Object.keys(root?.profiles ?? {})[0];
  if (!profile) throw new Error('请先创建桥接 profile');
  const paths = resolveAppPaths({ rootDir, profile });
  if (!root?.profiles[profile]) throw new Error('Profile 不存在');
  const path = join(paths.profileDir, 'web.json');
  if (action === 'configure') {
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    const { config, secret } = await configureWeb(path, options.host, options.port ? Number(options.port) : undefined);
    console.log(`网页：http://${config.host}:${config.port}\n登录码（仅显示一次）：${secret}\n配置后需重启桥接生效；此命令不会重启。重新 configure 会更换登录码。`);
    return;
  }
  const config = await loadWebConfig(path);
  if (action === 'disable' && config) await writeFileAtomic(path, JSON.stringify({ ...config, enabled: false }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ profile, configured: !!config, enabled: action === 'disable' ? false : config?.enabled ?? false,
    ...(config ? { url: `http://${config.host}:${config.port}` } : {}) }));
}
