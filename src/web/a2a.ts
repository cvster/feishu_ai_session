import { defaultAlias, loadA2AConfig, mintKey, saveA2AConfig, setAlias, type A2AConfig } from '../a2a/config';
import { withA2AConfigLock } from '../a2a/management';
import { WebError } from './service';
import { log } from '../core/logger';

export class WebA2AManagement {
  constructor(private deps: { path: string; owner(): string; target(id: string): Promise<{ scope: string; name: string }>; onCreated?(scope: string): Promise<void> }) {}
  private view(config: A2AConfig | undefined, scope: string, name: string, owner: string) {
    const endpoint = config?.endpoints[scope], alias = defaultAlias(scope);
    const baseUrl = config ? `http://${config.host}:${config.port}/${config.namespace}/agents/${alias}` : undefined;
    return { name, configured: !!config, listenerEnabled: config?.enabled === true, enabled: config?.enabled === true && endpoint?.enabled === true,
      defaultAlias: alias, alias: endpoint?.alias ?? '', baseUrl, agentCard: baseUrl && `${baseUrl}/agent-card.json`, protocol: 'A2A 1.0 HTTP+JSON',
      keys: endpoint?.keys.map(k => ({ id: k.id, name: k.name, role: k.role, active: !k.revoked && k.ownerId === owner })) ?? [] };
  }
  async read(id: string) {
    const owner = this.deps.owner(), target = await this.deps.target(id), config = await loadA2AConfig(this.deps.path);
    if (this.deps.owner() !== owner) throw new WebError(409, '所有者已变化，请刷新');
    return this.view(config, target.scope, target.name, owner);
  }
  async create(id: string, input: Record<string, unknown>) {
    if (Object.keys(input).some(k => !['alias', 'name'].includes(k)) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 ||
        input.alias !== undefined && typeof input.alias !== 'string') throw new WebError(400, '请填写调用者名称（1–80 字），以及可选的接口别名');
    const name = input.name.trim(), alias = typeof input.alias === 'string' ? input.alias.trim() : '';
    const owner = this.deps.owner();
    const created = await withA2AConfigLock(this.deps.path, async () => {
      const target = await this.deps.target(id), config = await loadA2AConfig(this.deps.path);
      if (!config?.enabled) throw new WebError(409, 'A2A 监听尚未启用，请先在本机配置并重启桥接');
      const endpoint = config.endpoints[target.scope] ??= { enabled: false, keys: [] };
      // A repeated click or uncertain HTTP retry must not silently mint another key.
      if (endpoint.keys.some(k => k.name === name && k.ownerId === owner && !k.revoked)) throw new WebError(409, '此调用者已有密钥；明文不能再次查询，请使用新的调用者名称签发新密钥');
      if (alias) {
        try { setAlias(config, target.scope, alias); }
        catch (error) { throw new WebError(400, (error as Error).message); }
      }
      const current = await this.deps.target(id);
      if (current.scope !== target.scope || this.deps.owner() !== owner) throw new WebError(409, '会话或所有者已变化，请刷新');
      const issued = mintKey(name, owner, 'member');
      endpoint.enabled = true; endpoint.keys.push(issued.key);
      await saveA2AConfig(this.deps.path, config);
      return { scope: target.scope, response: { ...this.view(config, target.scope, target.name, owner), credential: { keyId: issued.key.id, token: issued.token, role: issued.key.role } } };
    });
    // The credential is committed: a naming/reconciliation failure must not lose its one-time response.
    try { await this.deps.onCreated?.(created.scope); }
    catch (error) { log.warn('a2a', 'sharing-sync-pending', { error: String(error) }); }
    return created.response;
  }
}
