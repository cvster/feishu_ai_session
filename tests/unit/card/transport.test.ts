import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { installFeishuCardTransport, prepareFeishuCard } from '../../../src/card/transport';
import { publishCards, type MultipartDelivery } from '../../../src/card/multipart';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS0AAAAASUVORK5CYII=', 'base64');
const card = (content: string) => ({ schema: '2.0', body: { elements: [{ tag: 'markdown', content }] } });
function harness() {
  const image = vi.fn(async (_request: { data: { image_type: string; image: Buffer } }) => ({ image_key: 'img_v3_uploaded' }));
  const update = vi.fn(async (_request: { data: { card: { data: string }; sequence: number } }) => ({ code: 0, msg: 'ok' }));
  const create = vi.fn(async (_card: object) => ({ cardId: 'card_1' }));
  const send = vi.fn(async () => ({ code: 0, data: { message_id: 'om_1' } }));
  const channel = { createCard: create, updateCardById: vi.fn(), rawClient: { cardkit: { v1: { card: { update } } }, im: { v1: { image: { create: image }, message: { create: send } } } } } as unknown as LarkChannel;
  installFeishuCardTransport(channel);
  return { channel, create, image, update, send };
}
async function imageFile() {
  const root = await mkdtemp(join(tmpdir(), 'card-image-')); roots.push(root);
  const path = join(root, 'qr.png'); await writeFile(path, png); return path;
}
it('uploads a local QR image while preserving the complete authorization URL and the source card', async () => {
  const h=harness(), path=await imageFile();
  const url='https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=test_flow&user_code=TEST-CODE';
  const source=card(url+'\n\n![二维码]('+path+')');
  await h.channel.createCard(source);
  await h.channel.updateCardById('card_1',source,3);
  expect(h.image).toHaveBeenCalledOnce();
  expect(h.image.mock.calls[0]?.[0]).toMatchObject({data:{image_type:'message',image:png}});
  const sent=JSON.parse(h.update.mock.calls[0]![0].data.card.data);
  expect(sent.body.elements[0].content).toBe(url+'\n\n![二维码](img_v3_uploaded)');
  expect(source.body.elements[0]?.content).toContain(path);
});
it('keeps code examples literal and transforms images nested in emphasis, lists and tables', async () => {
  const h=harness(), path=await imageFile();
  const content='`![literal]('+path+')`\n\n```md\n![example]('+path+')\n```\n\n**![actual]('+path+')**\n\n- ![list]('+path+')\n\n| image |\n| --- |\n| ![table]('+path+') |';
  const result=await prepareFeishuCard(h.channel,card(content)) as ReturnType<typeof card>;
  expect(result.body.elements[0]!.content).toContain('`![literal]('+path+')`');
  expect(result.body.elements[0]!.content).toContain('```md\n![example]('+path+')\n```');
  expect(result.body.elements[0]!.content.match(/img_v3_uploaded/g)).toHaveLength(3);
  expect(h.image).toHaveBeenCalledOnce();
});
it('retains Feishu image keys and turns remote images into links without fetching them', async () => {
  const h=harness();
  const result=await prepareFeishuCard(h.channel,card('![key](img_v3_key)\n![remote](https://example.com/qr.png)')) as ReturnType<typeof card>;
  expect(result.body.elements[0]!.content).toBe('![key](img_v3_key)\n[remote](https://example.com/qr.png)');
  expect(h.image).not.toHaveBeenCalled();
});
it.each(['missing','non-image','upload-failed'] as const)('does not suppress the answer or its URL when a picture is %s', async kind => {
  const h=harness(), path=await imageFile();
  if(kind==='missing') await rm(path);
  if(kind==='non-image') await writeFile(path,'PRIVATE_CREDENTIAL');
  if(kind==='upload-failed') h.image.mockRejectedValueOnce(Error('upload unavailable'));
  await h.channel.createCard(card('https://example.com/auth?code=correct\n![qr]('+path+')'));
  expect(h.create.mock.calls[0]![0]).toEqual(card('https://example.com/auth?code=correct\nqr（图片暂不可用）'));
  if(kind!=='upload-failed') expect(h.image).not.toHaveBeenCalled();
});
it('rejects resolved CardKit business errors without marking a multipart update as delivered', async () => {
  const h=harness(); h.update.mockResolvedValueOnce({code:200570,msg:'invalid image resource'});
  const delivery: MultipartDelivery={sequence:0};
  const publish=()=>publishCards({channel:h.channel,target:{chatId:'oc_group'},key:'answer',card:card('full answer'),delivery,save:async()=>{},active:()=>true});
  await expect(publish()).rejects.toThrow('200570');
  expect(delivery.parts?.[0]?.hash).toBeUndefined();
  await publish();
  expect(h.send).toHaveBeenCalledOnce();
  expect(delivery.parts?.[0]?.hash).toBeDefined();
  expect(h.update.mock.calls.map(c=>c[0].data.sequence)).toEqual([1,2]);
});
