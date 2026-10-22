import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WebConfig {
  version: 1; enabled: boolean; host: string; port: number; secretHash: string;
  additionalHosts?: string[];
  /** IPv4 CIDRs whose direct socket peers may access the owner's Web UI without login. */
  trustedNetworks?: string[];
}
export const webListenHosts = (c: WebConfig): string[] => [c.host, ...(c.additionalHosts ?? [])];
const validNetwork = (network: unknown): network is string => typeof network === 'string' &&
  /^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(network) && isIPv4(network.split('/')[0]!);
const ipv4Number = (ip: string): number => ip.split('.').reduce((value, part) => value * 256 + Number(part), 0);
export function trustedWebPeer(config: WebConfig, address?: string): boolean {
  const ip = address?.replace(/^::ffff:/i, '');
  if (!ip || !isIPv4(ip)) return false;
  if (ip === '127.0.0.1' && webListenHosts(config).includes('127.0.0.1')) return true;
  return (config.trustedNetworks ?? []).some(network => {
    if (!validNetwork(network)) return false;
    const [base, bits] = network.split('/'), block = 2 ** (32 - Number(bits));
    return Math.floor(ipv4Number(ip) / block) === Math.floor(ipv4Number(base!) / block);
  });
}
export const webSecretHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function validWebConfig(v: unknown): v is WebConfig {
  const c = v as WebConfig;
  return !!c && c.version === 1 && typeof c.enabled === 'boolean' && isIPv4(c.host) && c.host !== '0.0.0.0' &&
    Number.isInteger(c.port) && c.port > 0 && c.port <= 65535 && /^[a-f0-9]{64}$/.test(c.secretHash) &&
    (c.additionalHosts === undefined || Array.isArray(c.additionalHosts) && c.additionalHosts.length <= 8 &&
      c.additionalHosts.every(ip => typeof ip === 'string' && isIPv4(ip) && ip !== '0.0.0.0') && new Set(webListenHosts(c)).size === webListenHosts(c).length) &&
    (c.trustedNetworks === undefined || Array.isArray(c.trustedNetworks) && c.trustedNetworks.length <= 32 && c.trustedNetworks.every(validNetwork));
}
export async function loadWebConfig(path: string): Promise<WebConfig | undefined> {
  try { const c: unknown = JSON.parse(await readFile(path, 'utf8')); if (!validWebConfig(c)) throw new Error('网页配置无效'); return c; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
export async function configureWeb(path: string, host = '127.0.0.1', port = 3345, access: Pick<WebConfig, 'additionalHosts' | 'trustedNetworks'> = {}) {
  const secret = randomBytes(32).toString('base64url');
  const config: WebConfig = { version: 1, enabled: true, host, port, secretHash: webSecretHash(secret), ...access };
  const locals = new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(r => r.family === 'IPv4').map(r => r.address)]);
  if (!validWebConfig(config) || !webListenHosts(config).every(ip => locals.has(ip))) throw new Error('请指定本机 IPv4 地址、有效端口和 IPv4 CIDR 网段；不支持监听所有网卡');
  await writeFileAtomic(path, JSON.stringify(config) + '\n', { mode: 0o600 });
  return { config, secret };
}
