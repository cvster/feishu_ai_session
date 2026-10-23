import { dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { configureWeb, loadWebConfig, webAccessUrls, trustedWebPeer } from '../../web/config';
import { writeFileAtomic } from '../../platform/atomic-write';
export async function runWeb(action: 'configure' | 'status' | 'disable', options: { profile?: string; config?: string; host?: string; port?: string; alsoHost?: string[]; trustedNetwork?: string[]; passwordEnv?: string }) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? Object.keys(root?.profiles ?? {})[0];
  if (!profile) throw new Error('请先创建桥接 profile');
  const paths = resolveAppPaths({ rootDir, profile });
  if (!root?.profiles[profile]) throw new Error('Profile 不存在');
  const path = join(paths.profileDir, 'web.json');
  if (action === 'configure') {
    const password = options.passwordEnv ? process.env[options.passwordEnv] : undefined;
    if (options.passwordEnv && !password) throw new Error('固定密码环境变量为空或不存在');
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    const { config, secret } = await configureWeb(path, options.host, options.port ? Number(options.port) : undefined,
      { ...(options.alsoHost ? { additionalHosts: options.alsoHost } : {}), ...(options.trustedNetwork ? { trustedNetworks: options.trustedNetwork } : {}) }, password);
    console.log(`网页：${webAccessUrls(config).join('、')}\n${trustedWebPeer(config, '127.0.0.1') ? '本机回环访问免登录。\n' : ''}${config.trustedNetworks?.length ? `免登录来源：${config.trustedNetworks.join('、')}\n` : ''}${config.passwordHash ? '固定密码已设置。\n' : ''}登录 Token（仅显示一次）：${secret}\n配置后需重启桥接生效；此命令不会重启。`);
    return;
  }
  const config = await loadWebConfig(path);
  if (action === 'disable' && config) await writeFileAtomic(path, JSON.stringify({ ...config, enabled: false }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ profile, configured: !!config, enabled: action === 'disable' ? false : config?.enabled ?? false,
    ...(config ? { url: webAccessUrls(config)[0], urls: webAccessUrls(config), host: config.host, port: config.port, fixedPassword: !!config.passwordHash,
      trustedNetworks: [...(trustedWebPeer(config, '127.0.0.1') ? ['127.0.0.1/32'] : []), ...(config.trustedNetworks ?? [])] } : {}) }));
}
