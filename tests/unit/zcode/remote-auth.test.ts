import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, tmpdir, userInfo } from 'node:os';
import { createCipheriv, createHash } from 'node:crypto';
import { readZcodeDesktopLogin, requestZcodeTerminalToken, zcodeDesktopCredentialFile } from '../../../src/agent/zcode/remote-auth';
const dirs: string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function credentials(encrypted=true) {
  const dir=await mkdtemp(join(tmpdir(),'zcode-auth-'));dirs.push(dir);
  const secret=process.env.ZCODE_CREDENTIAL_SECRET||`zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const wrap=(value:string)=>{
    if(!encrypted)return value;
    const iv=Buffer.alloc(12,9),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),iv);
    const data=Buffer.concat([cipher.update(value),cipher.final()]);
    return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  };
  const file=join(dir,'credentials.json');
  await writeFile(file,JSON.stringify({'oauth:active_provider':wrap('zai'),'oauth:zai:user_info':wrap(JSON.stringify({id:'native-user'})),zcodejwttoken:wrap('PRIVATE_NATIVE_JWT')}),{mode:0o600});
  return file;
}
it.each([true,false])('reads native desktop login in its existing credential format (encrypted=%s)',async encrypted=>{
  const file=await credentials(encrypted);expect(await readZcodeDesktopLogin(file)).toEqual({jwt:'PRIVATE_NATIVE_JWT'});
});
it('rejects corrupt credentials and insecure file permissions without including secrets in errors',async()=>{
  const file=await credentials();await chmod(file,0o644);
  await expect(readZcodeDesktopLogin(file)).rejects.toThrow('无法读取');
  await chmod(file,0o600);vi.stubEnv('ZCODE_CREDENTIAL_SECRET','different-secret');
  await expect(readZcodeDesktopLogin(file)).rejects.toThrow('未导出登录凭据');
});
it('uses fixed official authorization routes, checks ownership first, and only mints a terminal token',async()=>{
  const file=await credentials();
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:[{device_sid:'target',device_mid:'mid',online:true}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:{token:'A'.repeat(22),expires_in:60}})));
  vi.stubGlobal('fetch',fetcher);
  expect(await requestZcodeTerminalToken({deviceSid:'target',deviceMid:'mid'},file)).toBe('A'.repeat(22));
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://zcode.z.ai/api/v1/remote/device');
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://zcode.z.ai/api/v1/remote/token');
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({method:'POST',body:'{"role":"terminal"}',redirect:'error'});
  expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer PRIVATE_NATIVE_JWT');
});
it('does not mint tokens for another device, and redacts upstream authentication errors',async()=>{
  const file=await credentials();const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:[{device_sid:'other',online:true}]})));
  vi.stubGlobal('fetch',fetcher);
  await expect(requestZcodeTerminalToken({deviceSid:'target'},file)).rejects.toThrow('不属于当前');expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response('PRIVATE_UPSTREAM_DETAIL',{status:401}));
  await expect(requestZcodeTerminalToken({deviceSid:'target'},file)).rejects.toThrow('登录已失效');
});
it('resolves desktop login beside configured model files without changing the session data directory',()=>{
  expect(zcodeDesktopCredentialFile('/private/zcode/config.json')).toBe('/private/zcode/credentials.json');
  expect(zcodeDesktopCredentialFile('/private/zcode')).toBe('/private/zcode/credentials.json');
});
