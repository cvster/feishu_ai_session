import { dirname, join, resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile, saveRootConfig, withConfigFileLock } from '../../config/profile-store';
import { loadRuntimeEnv } from '../../config/runtime-env';
import { readWorkerConfig } from '../../worker/config';
import { importZcodeToPi, renamePiModel } from '../../agent/pi/import-zcode';
import type { ZcodeOptions } from '../../agent/zcode/client';
import { ToolBindingStore } from '../../tools/bindings';
import { piStorageDir } from '../../agent/pi/client';

export async function runPiImport(options: { profile?: string; config?: string; agentDir?: string }) {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir);
  if (!profile) throw Error('请指定 --profile');
  await loadRuntimeEnv(profile, rootDir);
  const paths = resolveAppPaths({ profile, rootDir }), root = await loadRootConfig(paths.configFile), selected = root?.profiles[profile];
  if (!selected) throw Error('profile 不存在');
  const source = (await readWorkerConfig(paths.profileDir, 'zcode'))?.options ?? selected.zcode ?? {};
  const target = (await readWorkerConfig(paths.profileDir, 'pi'))?.options ?? selected.pi ?? {};
  const piOptions = { agentDir: options.agentDir ?? (target as { agentDir?: string }).agentDir };
  const result = await importZcodeToPi(source as ZcodeOptions, piOptions);
  const bindings = new ToolBindingStore(join(paths.profileDir, 'tool-bindings.json')); await bindings.load();
  for (const [scope, binding] of bindings.entries()) if (binding.toolId === 'pi' && binding.sourceId === piStorageDir(piOptions) && !binding.sharedScope && binding.model) {
    const model = renamePiModel(binding.model, result.providerIds);
    if (model !== binding.model) bindings.set(scope, { ...binding, model });
  }
  await bindings.flush();
  if (selected.agentKind === 'pi') await withConfigFileLock(paths.configFile, async () => {
    const current = await loadRootConfig(paths.configFile), target = current?.profiles[profile];
    if (current && target?.agentKind === 'pi' && target.preferences.model) {
      const model = renamePiModel(target.preferences.model, result.providerIds);
      if (model !== target.preferences.model) { target.preferences.model = model; await saveRootConfig(current, paths.configFile); }
    }
  });
  console.log(`已导入 ${result.providers} 个供应商、${result.models} 个模型到 ${result.path}（权限 600），已迁移 ${result.migratedSessions} 个会话的模型标识；刷新桥接模型并重新打开 Pi 终端即可使用。`);
}
