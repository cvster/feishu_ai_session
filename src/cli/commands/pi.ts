import { dirname, resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { loadRuntimeEnv } from '../../config/runtime-env';
import { readWorkerConfig } from '../../worker/config';
import { importZcodeToPi } from '../../agent/pi/import-zcode';
import type { ZcodeOptions } from '../../agent/zcode/client';

export async function runPiImport(options: { profile?: string; config?: string; agentDir?: string }) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir);
  if (!profile) throw Error('请指定 --profile');
  await loadRuntimeEnv(profile, rootDir);
  const paths = resolveAppPaths({ profile, rootDir }), root = await loadRootConfig(paths.configFile), selected = root?.profiles[profile];
  if (!selected) throw Error('profile 不存在');
  const source = (await readWorkerConfig(paths.profileDir, 'zcode'))?.options ?? selected.zcode ?? {};
  const target = (await readWorkerConfig(paths.profileDir, 'pi'))?.options ?? selected.pi ?? {};
  const result = await importZcodeToPi(source as ZcodeOptions, { agentDir: options.agentDir ?? (target as { agentDir?: string }).agentDir });
  console.log(`已导入 ${result.providers} 个供应商、${result.models} 个模型到 ${result.path}（权限 600）；刷新 Pi 模型即可使用。`);
}
