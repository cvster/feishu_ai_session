import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, extname, join } from 'node:path';

/** Native desktop credential location; never copy its JWT into the pairing file. */
export function zcodeDesktopCredentialFile(modelConfigPath?: string): string {
  const directory = modelConfigPath ? extname(modelConfigPath) === '.json' ? dirname(modelConfigPath) : modelConfigPath : join(homedir(), '.zcode', 'v2');
  return join(directory, 'credentials.json');
}
/** Interoperates with ZCode's credentialCipherProvider enc:v1 AES-GCM format.
 * Only reads current desktop login; never writes, refreshes, logs or exports credentials.
 */
export async function readZcodeDesktopLogin(file: string): Promise<{ jwt: string }> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let values: Record<string, string>;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error();
      values = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    const decrypt = (value: unknown): string => {
      if (typeof value !== 'string') throw new Error();
      if (!value.startsWith('enc:v1:')) return value;
      const parts = value.slice(7).split('.');
      if (parts.length !== 3) throw new Error();
      const [iv, tag, data] = parts.map(part => Buffer.from(part, 'base64url'));
      if (iv?.length !== 12 || tag?.length !== 16 || !data?.length) throw new Error();
      const secret = process.env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    };
    const provider = decrypt(values['oauth:active_provider']).trim();
    if (!['zai', 'bigmodel'].includes(provider)) throw new Error();
    const user = JSON.parse(decrypt(values[`oauth:${provider}:user_info`]));
    if (!(typeof user.id === 'string' && user.id.trim()) && !(typeof user.user_id === 'string' && user.user_id.trim())) throw new Error();
    const jwt = decrypt(values.zcodejwttoken).trim();
    if (!jwt || jwt.length > 65536 || !/^[\x21-\x7e]+$/.test(jwt)) throw new Error();
    return { jwt };
  } catch { throw new Error('无法读取 ZCode 桌面当前登录态，请在桌面登录后重新配对；未导出登录凭据。'); }
}

export async function requestZcodeTerminalToken(pair: { deviceSid: string; deviceMid?: string }, credentialFile: string,
  /** A loopback fixture can override the API origin; product callers use the fixed official origin. */ testOrigin?: string): Promise<string> {
  const origin = testOrigin ?? 'https://zcode.z.ai';
  if (testOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testOrigin)) throw new Error('Invalid test API');
  const { jwt } = await readZcodeDesktopLogin(credentialFile);
  const request = async (path: string, body?: object): Promise<any> => {
    let result: Response;
    try { result = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw new Error('ZCode 远控授权服务连接失败，未发送会话消息。'); }
    if (result.status === 401 || result.status === 403) throw new Error('ZCode 桌面登录已失效或无权连接此设备，请在桌面重新登录。');
    if (!result.ok) throw new Error('ZCode 远控授权服务未接受请求，未发送会话消息。');
    const raw = await result.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('ZCode remote API response too large');
    let value: any; try { value = JSON.parse(raw); } catch { throw new Error('Invalid ZCode remote API response'); }
    if (value?.code !== 0) throw new Error('ZCode 远控授权失败，请检查桌面账号与远控状态。');
    return value.data;
  };
  const devices = await request('/api/v1/remote/device');
  const matched = Array.isArray(devices) ? devices.filter(d => d.device_sid === pair.deviceSid && (!pair.deviceMid || d.device_mid === pair.deviceMid)) : [];
  if (matched.length !== 1 || matched[0].online !== true) throw new Error('远控设备不属于当前 ZCode 账号或未在线，请检查复制链接的桌面窗口。');
  const token = await request('/api/v1/remote/token', { role: 'terminal' });
  if (typeof token?.token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(token.token) || !Number.isInteger(token.expires_in) || token.expires_in < 1) throw new Error('Invalid ZCode terminal token');
  return token.token;
}
