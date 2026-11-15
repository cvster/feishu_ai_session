import { expect, it, vi } from 'vitest';
import { connectForLocalWeb } from '../../../src/web/offline-start';
it('starts local Web after a nested quota failure but not without configured Web', async () => {
  const error = Object.assign(new Error('bot identity unavailable'), {cause:{response:{status:429,data:{code:99991403}}}});
  const channel={connect:vi.fn(async()=>{throw error;})};
  await expect(connectForLocalWeb(channel,true)).resolves.toBe(false);
  await expect(connectForLocalWeb(channel,false)).rejects.toBe(error);
});
it('does not bypass authentication errors and preserves healthy connection behavior', async()=>{
  await expect(connectForLocalWeb({connect:async()=>{}},true)).resolves.toBe(true);
  const error=Object.assign(new Error('unauthorized'),{response:{status:401}});
  await expect(connectForLocalWeb({connect:async()=>{throw error;}},true)).rejects.toBe(error);
});
