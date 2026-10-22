import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WebConfig { version: 1; enabled: boolean; host: string; port: number; secretHash: string }
export const webSecretHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function validWebConfig(v: unknown): v is WebConfig {
  const c = v as WebConfig;
  return !!c && c.version === 1 && typeof c.enabled === 'boolean' && isIPv4(c.host) && c.host !== '0.0.0.0' &&
    Number.isInteger(c.port) && c.port > 0 && c.port <= 65535 && /^[a-f0-9]{64}$/.test(c.secretHash);
}
export async function loadWebConfig(path: string): Promise<WebConfig | undefined> {
  try { const c: unknown = JSON.parse(await readFile(path, 'utf8')); if (!validWebConfig(c)) throw new Error('网页配置无效'); return c; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
export async function configureWeb(path: string, host = '127.0.0.1', port = 3345) {
  const secret = randomBytes(32).toString('base64url');
  const config: WebConfig = { version: 1, enabled: true, host, port, secretHash: webSecretHash(secret) };
  const local = host === '127.0.0.1' || Object.values(networkInterfaces()).flatMap(rows => rows ?? []).some(r => r.family === 'IPv4' && r.address === host);
  if (!validWebConfig(config) || !local) throw new Error('请指定本机 IPv4 地址和有效端口；不支持监听所有网卡');
  await writeFileAtomic(path, JSON.stringify(config) + '\n', { mode: 0o600 });
  return { config, secret };
}
