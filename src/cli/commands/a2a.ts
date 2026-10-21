import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as lockfile from 'proper-lockfile';
import { createLarkChannel } from '@larksuite/channel';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile, runtimeProfileConfig } from '../../config/profile-store';
import { resolveAppSecret } from '../../config/secret-resolver';
import { loadRuntimeEnv } from '../../config/runtime-env';
import { createDirectLarkHttpInstance } from '../../platform/lark-http';
import { ToolBindingStore } from '../../tools/bindings';
import { DEFAULT_A2A_PORT, defaultAlias, endpointForAlias, loadA2AConfig, mintKey, saveA2AConfig, select10Address, setAlias, validSlug } from '../../a2a/config';

export interface A2AOptions { profile?: string; config?: string; namespace?: string; host?: string; port?: string; alias?: string; name?: string; owner?: boolean; keyId?: string }
export async function runA2A(action: 'configure' | 'list' | 'enable' | 'disable' | 'alias' | 'grant' | 'revoke', target: string | undefined, options: A2AOptions): Promise<void> {
  const rootDir = options.config ? dirname(resolve(options.config)) : undefined;
  const profile = options.profile ?? await readActiveProfile(rootDir) ?? 'codex';
  await loadRuntimeEnv(profile, rootDir);
  const paths = resolveAppPaths({ rootDir, profile }), root = await loadRootConfig(paths.configFile);
  if (!root?.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  const bindings = new ToolBindingStore(join(paths.profileDir, 'tool-bindings.json')); await bindings.load();
  const sessions = bindings.entries().filter(([, b]) => b.linkedSource && !b.sharedScope);
  const path = join(paths.profileDir, 'a2a.json');
  await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
  const lockPath = join(paths.profileDir, 'a2a-config.lock'); await writeFile(lockPath, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(lockPath, { realpath: false, retries: 3 });
  try {
    let config = await loadA2AConfig(path);
    if (action === 'configure') {
      const namespace = options.namespace ?? config?.namespace;
      if (!validSlug(namespace)) throw new Error('请用 --namespace 指定稳定用户名，例如 LennoxGao');
      if (config && config.namespace !== namespace) throw new Error('用户名命名空间已固定，不能随昵称更换，以免已有调用连错服务');
      const host = options.host ?? config?.host ?? select10Address(), port = Number(options.port ?? config?.port ?? DEFAULT_A2A_PORT);
      const local = Object.values(networkInterfaces()).flatMap(r => r ?? []).some(r => r.family === 'IPv4' && r.address === host);
      if (!isIPv4(host) || !local || !host.startsWith('10.88.')) throw new Error('--host 必须是本机 10.88 网口的 IPv4 地址');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
      config = { version: 1, enabled: true, namespace, host, port, endpoints: config?.endpoints ?? {} };
      await saveA2AConfig(path, config);
      console.log(`A2A 已配置：http://${host}:${port}/${namespace}/agents/<别名>。首次启用或更改监听地址后，需要部署/重启桥接；本命令不会重启。`); return;
    }
    if (action === 'list') {
      for (const [scope, binding] of sessions) {
        const e = config?.endpoints[scope];
        console.log(JSON.stringify({ id: scope, name: binding.name, defaultAlias: defaultAlias(scope), alias: e?.alias,
          enabled: config?.enabled === true && e?.enabled === true,
          keys: e?.keys.map(({ id, name, role, revoked }) => ({ id, name, role, revoked: !!revoked })) ?? [] }));
      }
      return;
    }
    if (!config) throw new Error('请先执行 a2a configure');
    const scope = (target && endpointForAlias(config, target)?.[0]) ?? sessions.find(([s]) => s === target || defaultAlias(s) === target)?.[0];
    if (!scope) throw new Error('会话入口不存在，请通过 a2a list 选择默认别名或内部 ID');
    const binding = bindings.get(scope)!;
    if (!binding.linkedSource || binding.sharedScope || binding.nativeId !== binding.linkedSource.nativeId) throw new Error('不是原会话共享入口');
    if (binding.nativeId && bindings.isArchived(binding.toolId, binding.sourceId, binding.nativeId)) throw new Error('原会话已归档');
    const endpoint = config.endpoints[scope] ??= { enabled: false, keys: [] };
    if (action === 'enable') { endpoint.enabled = true; if (options.alias) setAlias(config, scope, options.alias); }
    if (action === 'disable') endpoint.enabled = false;
    if (action === 'alias') { if (!options.alias) throw new Error('需要 --alias'); setAlias(config, scope, options.alias); }
    if (action === 'revoke') {
      const key = endpoint.keys.find(k => k.id === options.keyId); if (!key) throw new Error('密钥 ID 不存在'); key.revoked = true;
    }
    let issued: ReturnType<typeof mintKey> | undefined;
    if (action === 'grant') {
      if (!endpoint.enabled || !options.name) throw new Error('先启用接口，并通过 --name 指定调用者名称');
      const cfg = runtimeProfileConfig(root, profile), appSecret = await resolveAppSecret(cfg, paths);
      const channel = createLarkChannel({ appId: cfg.accounts.app.id, appSecret,
        domain: cfg.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
        httpInstance: process.env.LARK_CHANNEL_FEISHU_USE_PROXY === '1' ? undefined : createDirectLarkHttpInstance(30_000),
        respectProxyEnv: process.env.LARK_CHANNEL_FEISHU_USE_PROXY === '1' });
      const info = await channel.getAppInfo({ userIdType: 'open_id' });
      if (!info.ownerId) throw new Error('无法确认当前飞书 CLI 所有者，未签发密钥');
      issued = mintKey(options.name, info.ownerId, options.owner ? 'owner' : 'member'); endpoint.keys.push(issued.key);
    }
    await saveA2AConfig(path, config);
    const base = `http://${config.host}:${config.port}/${config.namespace}/agents/${defaultAlias(scope)}`;
    console.log(JSON.stringify({ defaultAlias: defaultAlias(scope), alias: endpoint.alias, enabled: endpoint.enabled,
      agentCard: `${base}/agent-card.json`, ...(issued ? { keyId: issued.key.id, role: issued.key.role, token: issued.token,
        notice: '密钥仅显示一次；普通密钥不自动获得所有者权限。' } : {}) }, null, 2));
  } finally { await release(); }
}
