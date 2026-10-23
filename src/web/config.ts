import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WebConfig {
  version: 1; enabled: boolean; host: string; port: number; secretHash: string;
  /** Salted scrypt hash of an optional fixed login password. Never plaintext. */
  passwordHash?: string;
  additionalHosts?: string[];
  /** IPv4 CIDRs whose direct socket peers may access the owner's Web UI without login. */
  trustedNetworks?: string[];
}
export const webListenHosts = (c: WebConfig): string[] => [c.host, ...(c.additionalHosts ?? [])];
const wildcard = (host: string) => host === '0.0.0.0' || host === '::';
const loopbackListener = (c: WebConfig) => webListenHosts(c).some(host => host === '127.0.0.1' || wildcard(host));
const addressHost = (host: string) => host.includes(':') ? `[${host}]` : host;
export function webAccessUrls(c: WebConfig): string[] {
  const hosts = wildcard(c.host) ? ['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(rows => rows ?? [])
    .filter(row => row.family === 'IPv4' && !row.internal).map(row => row.address), ...(c.host === '::' ? ['::1'] : [])] : webListenHosts(c);
  return [...new Set(hosts)].map(host => `http://${addressHost(host)}:${c.port}`);
}
/** Wildcard listeners accept their actual destination IP, never arbitrary Host names. */
export function webHostAllowed(c: WebConfig, header?: string, localAddress?: string): boolean {
  const address = localAddress?.replace(/^::ffff:/i, '');
  const hosts = wildcard(c.host) ? (address ? [address] : []) : webListenHosts(c);
  return hosts.some(host => header === `${addressHost(host)}:${c.port}`) ||
    (wildcard(c.host) ? address === '127.0.0.1' || address === '::1' : hosts.includes('127.0.0.1')) && header === `localhost:${c.port}`;
}
const validNetwork = (network: unknown): network is string => typeof network === 'string' &&
  /^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(network) && isIPv4(network.split('/')[0]!);
const ipv4Number = (ip: string): number => ip.split('.').reduce((value, part) => value * 256 + Number(part), 0);
export function trustedWebPeer(config: WebConfig, address?: string): boolean {
  const ip = address?.replace(/^::ffff:/i, '');
  if (ip === '::1' && config.host === '::') return true;
  if (!ip || !isIPv4(ip)) return false;
  if (ip === '127.0.0.1' && loopbackListener(config)) return true;
  return (config.trustedNetworks ?? []).some(network => {
    if (!validNetwork(network)) return false;
    const [base, bits] = network.split('/'), block = 2 ** (32 - Number(bits));
    return Math.floor(ipv4Number(ip) / block) === Math.floor(ipv4Number(base!) / block);
  });
}
export const webSecretHash = (value: string) => createHash('sha256').update(value).digest('hex');
const passwordFormat = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const passwordKey = (value: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) =>
  scrypt(value, salt, 32, (error, key) => error ? reject(error) : resolve(key)));
export async function webPasswordHash(value: string): Promise<string> {
  if (!value || value.length > 200) throw new Error('固定密码须为 1–200 个字符');
  const salt = randomBytes(16), key = await passwordKey(value, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyWebCredential(c: WebConfig, value: unknown, allowPassword = true): Promise<boolean> {
  if (typeof value !== 'string' || !value || value.length > 200) return false;
  if (timingSafeEqual(Buffer.from(webSecretHash(value), 'hex'), Buffer.from(c.secretHash, 'hex'))) return true;
  const password = allowPassword && c.passwordHash ? passwordFormat.exec(c.passwordHash) : null;
  return !!password && timingSafeEqual(await passwordKey(value, Buffer.from(password[1]!, 'hex')), Buffer.from(password[2]!, 'hex'));
}
export const webCredentialSignature = (c: WebConfig) => JSON.stringify([c.secretHash, c.passwordHash ?? null]);
export function validWebConfig(v: unknown): v is WebConfig {
  const c = v as WebConfig;
  return !!c && c.version === 1 && typeof c.enabled === 'boolean' && (isIPv4(c.host) || c.host === '::') &&
    Number.isInteger(c.port) && c.port > 0 && c.port <= 65535 && /^[a-f0-9]{64}$/.test(c.secretHash) &&
    (c.passwordHash === undefined || typeof c.passwordHash === 'string' && passwordFormat.test(c.passwordHash)) &&
    (c.additionalHosts === undefined || Array.isArray(c.additionalHosts) && c.additionalHosts.length <= 8 &&
      (!wildcard(c.host) || c.additionalHosts.length === 0) &&
      c.additionalHosts.every(ip => typeof ip === 'string' && isIPv4(ip) && ip !== '0.0.0.0') && new Set(webListenHosts(c)).size === webListenHosts(c).length) &&
    (c.trustedNetworks === undefined || Array.isArray(c.trustedNetworks) && c.trustedNetworks.length <= 32 && c.trustedNetworks.every(validNetwork));
}
export async function loadWebConfig(path: string): Promise<WebConfig | undefined> {
  try { const c: unknown = JSON.parse(await readFile(path, 'utf8')); if (!validWebConfig(c)) throw new Error('网页配置无效'); return c; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
export async function configureWeb(path: string, host = '127.0.0.1', port = 3345, access: Pick<WebConfig, 'additionalHosts' | 'trustedNetworks'> = {}, password?: string) {
  const secret = randomBytes(32).toString('base64url');
  const config: WebConfig = { version: 1, enabled: true, host, port, secretHash: webSecretHash(secret), ...access,
    ...(password === undefined ? {} : { passwordHash: await webPasswordHash(password) }) };
  const locals = new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(r => r.family === 'IPv4').map(r => r.address)]);
  if (!validWebConfig(config) || !webListenHosts(config).every(ip => wildcard(ip) || locals.has(ip))) throw new Error('请指定本机 IPv4、0.0.0.0 或 ::、有效端口和 IPv4 CIDR 网段；监听所有网卡时无需额外监听地址');
  await writeFileAtomic(path, JSON.stringify(config) + '\n', { mode: 0o600 });
  return { config, secret };
}
