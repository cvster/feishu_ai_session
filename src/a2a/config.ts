import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ApiKey { id: string; name: string; hash: string; ownerId: string; role: 'member' | 'owner'; revoked?: boolean }
export interface ApiEndpoint { enabled: boolean; alias?: string; retiredAliases?: string[]; keys: ApiKey[] }
export interface A2AConfig {
  version: 1;
  enabled: boolean;
  namespace: string;
  host: string;
  port: number;
  endpoints: Record<string, ApiEndpoint>;
}
export const DEFAULT_A2A_PORT = 36999;
export const validSlug = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
export function defaultAlias(sharedScope: string): string {
  if (!/^aux_[\w-]+$/.test(sharedScope)) throw new Error('不是会话共享入口 ID');
  return `session-${sharedScope.slice(4)}`;
}
export function endpointForAlias(config: A2AConfig, alias: string): [string, ApiEndpoint] | undefined {
  return Object.entries(config.endpoints).find(([scope, e]) => alias === defaultAlias(scope) || alias === e.alias);
}
export function setAlias(config: A2AConfig, scope: string, alias: string): void {
  if (!validSlug(alias) || alias.startsWith('session-')) throw new Error('易读别名须为 1–80 位字母、数字、下划线或连字符；session- 前缀留给永久别名');
  const endpoint = config.endpoints[scope];
  if (!endpoint) throw new Error('接口尚未配置');
  if (Object.entries(config.endpoints).some(([other, e]) => (other !== scope && e.alias === alias) || e.retiredAliases?.includes(alias))) throw new Error('别名已使用或已停用，不可重新分配');
  if (endpoint.alias && endpoint.alias !== alias) endpoint.retiredAliases = [...(endpoint.retiredAliases ?? []), endpoint.alias];
  endpoint.alias = alias;
}
export function select10Address(): string {
  const addresses = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(r => r.family === 'IPv4' && r.address.startsWith('10.88.') && !r.internal).map(r => r.address);
  const unique = [...new Set(addresses)];
  if (unique.length !== 1) throw new Error('无法唯一确定 10.88 网口，请用 --host 指定本机 IPv4 地址');
  return unique[0]!;
}
export function mintKey(name: string, ownerId: string, role: ApiKey['role'] = 'member'): { token: string; key: ApiKey } {
  if (!name.trim() || name.length > 80 || !ownerId) throw new Error('需要密钥名称及当前飞书应用所有者');
  const token = `a2a_${randomBytes(32).toString('base64url')}`;
  return { token, key: { id: randomBytes(12).toString('hex'), name, hash: hashToken(token), role, ownerId } };
}
function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function authenticate(endpoint: ApiEndpoint, authorization: string | undefined, ownerId: string): ApiKey | undefined {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 512) return;
  const supplied = Buffer.from(hashToken(authorization.slice(7)), 'hex');
  return endpoint.keys.find(k => !k.revoked && k.ownerId === ownerId && k.hash.length === 64 && timingSafeEqual(supplied, Buffer.from(k.hash, 'hex')));
}
export async function loadA2AConfig(path: string): Promise<A2AConfig | undefined> {
  let raw: A2AConfig;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  if (raw.version !== 1 || typeof raw.enabled !== 'boolean' || !validSlug(raw.namespace) || !isIPv4(raw.host) || raw.host === '0.0.0.0' ||
      !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !raw.endpoints || Array.isArray(raw.endpoints)) throw new Error('Invalid A2A configuration');
  const used = new Set<string>();
  for (const [scope, e] of Object.entries(raw.endpoints)) {
    const names = [defaultAlias(scope), ...(e.alias ? [e.alias] : []), ...(e.retiredAliases ?? [])];
    if (typeof e.enabled !== 'boolean' || !Array.isArray(e.keys) || names.some(a => !validSlug(a) || used.has(a)) ||
        (e.alias && e.alias.startsWith('session-'))) throw new Error('Invalid A2A aliases');
    for (const name of names) used.add(name);
    if (e.keys.some(k => !k.id || !k.name || !/^[a-f0-9]{64}$/.test(k.hash) || !k.ownerId || !['member', 'owner'].includes(k.role))) throw new Error('Invalid A2A credentials');
  }
  return raw;
}
export async function saveA2AConfig(path: string, config: A2AConfig): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
