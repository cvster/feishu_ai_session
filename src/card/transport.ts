import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, type Token } from 'marked';
import { log } from '../core/logger';

const uploads = new WeakMap<LarkChannel, Map<string, Promise<string>>>();
const installed = new WeakSet<LarkChannel>();
const IMAGE_LIMIT = 10 * 1024 * 1024;

async function imageKey(channel: LarkChannel, path: string): Promise<string> {
  const file = await open(path, 'r');
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > IMAGE_LIMIT) throw new Error('Local image is not a supported file');
    bytes = Buffer.alloc(Math.min(IMAGE_LIMIT + 1, stat.size + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
  if (bytes.length > IMAGE_LIMIT || !(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) ||
    bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')) throw new Error('Local file is not a supported image');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let cache = uploads.get(channel);
  if (!cache) { cache = new Map(); uploads.set(channel, cache); }
  let pending = cache.get(digest);
  if (!pending) {
    pending = (async () => {
      const response = await channel.rawClient.im.v1.image.create({ data: { image_type: 'message', image: bytes } });
      if (!response?.image_key) throw new Error('Image upload returned no key');
      return response.image_key;
    })();
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(digest, pending);
  }
  try { return await pending; }
  catch (error) { if (cache.get(digest) === pending) cache.delete(digest); throw error; }
}

/** CardKit images accept uploaded keys, not local paths or remote URLs. */
async function cardMarkdown(channel: LarkChannel, content: string): Promise<string> {
  if (!content.includes('![')) return content;
  async function rewrite(raw: string, tokens: Token[]): Promise<string> {
    let result = '', offset = 0;
    for (const token of tokens) {
      const start = raw.indexOf(token.raw, offset);
      if (start < 0) continue;
      result += raw.slice(offset, start);
      let replacement = token.raw;
      if (token.type === 'image' && !/^img_[A-Za-z0-9_-]+$/.test(token.href)) {
        const label = token.text.replace(/[\[\]`<>]/g, '') || '图片';
        if (/^https?:\/\//i.test(token.href)) replacement = `[${label}](${token.href})`;
        else {
          try {
            const path = token.href.startsWith('file:') ? fileURLToPath(token.href) : token.href;
            if (!isAbsolute(path)) throw new Error('Image path must be absolute');
            replacement = `![${label}](${await imageKey(channel, path)})`;
          } catch {
            // One missing/invalid picture must not suppress the answer or its links.
            log.warn('card', 'image-unavailable');
            replacement = `${label}（图片暂不可用）`;
          }
        }
      } else if (token.type !== 'code' && token.type !== 'codespan' && token.type !== 'html') {
        const children = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens :
          token.type === 'list' ? token.items : token.type === 'table' ? [...token.header, ...token.rows.flat()].flatMap(cell => cell.tokens) : [];
        if (children.length) replacement = await rewrite(token.raw, children);
      }
      result += replacement; offset = start + token.raw.length;
    }
    return result + raw.slice(offset);
  }
  return rewrite(content, marked.lexer(content));
}

export async function prepareFeishuCard(channel: LarkChannel, card: object): Promise<object> {
  async function visit(value: any): Promise<any> {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== 'object') return value;
    const result = { ...value };
    for (const [key, child] of Object.entries(value)) {
      result[key] = value.tag === 'markdown' && key === 'content' && typeof child === 'string'
        ? await cardMarkdown(channel, child) : await visit(child);
    }
    return result;
  }
  return visit(card);
}

/** One transport boundary for every tool and card publisher. */
export function installFeishuCardTransport(channel: LarkChannel): void {
  if (installed.has(channel)) return;
  installed.add(channel);
  const create = channel.createCard.bind(channel);
  channel.createCard = async card => create(await prepareFeishuCard(channel, card));
  channel.updateCardById = async (cardId, card, sequence) => {
    const prepared = await prepareFeishuCard(channel, card);
    const response = await channel.rawClient.cardkit.v1.card.update({ path: { card_id: cardId }, data: {
      card: { type: 'card_json', data: JSON.stringify(prepared) }, sequence, uuid: `u_${cardId}_${sequence}`,
    } });
    if (response.code) throw new Error(`Feishu CardKit update rejected (${response.code}): ${response.msg ?? 'unknown error'}`);
  };
}
