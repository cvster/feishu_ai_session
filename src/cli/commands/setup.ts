import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import { preFlightChecks } from '../preflight';
import { readFile } from 'node:fs/promises';

export async function runSetup(options: { profile: string; config?: string }): Promise<void> {
  const { cfg, profileConfig, appPaths, configPath } = await resolveProfileRuntime({ ...options, allowBootstrap: false });
  await preFlightChecks({ bridgeConfig: cfg, profileConfig, appPaths,
    larkChannel: { profile: appPaths.profile, rootDir: appPaths.rootDir, configPath,
      larkCliConfigDir: appPaths.larkCliConfigDir, larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile } });
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8'));
    if (!raw.apps?.some((app: { appId?: string; brand?: string }) => app.appId === cfg.accounts.app.id && app.brand === cfg.accounts.app.tenant)) throw new Error();
  } catch { throw new Error('飞书 CLI 绑定尚未完成；请检查 CLI 安装、当前 profile 的应用配置和日志后重试 setup'); }
  console.log('已完成当前 profile 的飞书 CLI 配置检查；未启动桥接或执行服务。请继续 doctor --runtime 验证。');
}
