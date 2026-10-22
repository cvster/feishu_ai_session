import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile, withConfigFileLock } from '../../config/profile-store';
import { writeFileAtomic } from '../../platform/atomic-write';
import { parseZcodePairing, ZcodeRemoteClient } from '../../agent/zcode/remote-client';
import { zcodeDesktopCredentialFile } from '../../agent/zcode/remote-auth';
import { loadWorkerConfig, readWorkerConfig } from '../../worker/config';

/** Read from stdin, never a CLI argument (process lists / shell history). No link echo. */
export async function runZcodePair(options: { profile?: string; config?: string; workspace?: string }) {
  if (process.stdin.isTTY) throw new Error('请从 stdin 输入远控链接，例如从私密文件重定向；不要把链接放在命令参数中');
  let link = '';
  for await (const chunk of process.stdin) {
    link += chunk.toString();
    if (Buffer.byteLength(link) > 16_384) throw new Error('ZCode 远控链接过长');
  }
  parseZcodePairing(link);
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? 'codex';
  const paths = resolveAppPaths({ rootDir, profile });
  const configFile = options.config ?? paths.configFile;
  await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
  const file = join(paths.profileDir, `zcode-remote-${randomUUID()}.link`);
  await writeFileAtomic(file, link.trim() + '\n', { mode: 0o600 });
  let saved = false;
  try {
    if (options.workspace) {
      const current = await loadRootConfig(configFile), workerConfig = await readWorkerConfig(paths.profileDir, 'zcode');
      const modelConfigPath = workerConfig ? workerConfig.options.modelConfigPath : current?.profiles[profile]?.zcode?.modelConfigPath;
      const client = new ZcodeRemoteClient(file, resolve(options.workspace), undefined, zcodeDesktopCredentialFile(typeof modelConfigPath === 'string' ? modelConfigPath : undefined));
      try { await client.request('workspace/updateProviderRegistry', {}); }
      finally { await client.close(); }
    }
    await withConfigFileLock(configFile, async () => {
      const root = await loadRootConfig(configFile), selected = root?.profiles[profile];
      if (!root || !selected) throw new Error(`profile not found: ${profile}`);
      const workerConfig = await loadWorkerConfig(paths.profileDir, 'zcode', selected);
      workerConfig.options.remoteControlFile = file;
      await writeFileAtomic(join(paths.profileDir, 'workers', 'zcode', 'config.json'), JSON.stringify(workerConfig, null, 2), { mode: 0o600 }); saved = true;
    });
    console.log(`ZCode 桌面远控配置已保存（凭据权限 600）${options.workspace ? '，连接和工作区验证通过' : '，尚未连接验证'}。需要单独升级/重启 ZCode worker 和重启桥接后生效；本命令不会重启服务。`);
  } finally { if (!saved) await unlink(file).catch(() => {}); }
}
