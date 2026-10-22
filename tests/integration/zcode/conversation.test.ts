import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ZcodeNativeConversationReader } from '../../../src/agent/zcode/conversation';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
it('refreshes durable native messages without sending input, registry changes or touching a remote terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-native-reader-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'data.json'), cli = join(dir, 'cli.mjs');
  await writeFile(cli, `import {createInterface} from 'node:readline'; import {readFile} from 'node:fs/promises';
createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);
if(!['session/resume','session/read'].includes(r.method)) {process.stdout.write(JSON.stringify({id:r.id,error:{code:-1,message:'mutation forbidden'}})+'\\n');return;}
const result=JSON.parse(await readFile(${JSON.stringify(data)},'utf8'));
process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`);
  const initial = { session: { sessionId: 'sess_native', sessionKind: 'interactive', workspace: { workspacePath: dir } }, messages: [] as any[] };
  await writeFile(data, JSON.stringify(initial));
  const nativeStop = vi.fn(async () => true);
  const reader = new ZcodeNativeConversationReader({ binary: process.execPath, args: [cli] }, nativeStop); cleanup.push(() => reader.close());
  expect((await reader.read('sess_native')).turns).toEqual([]);
  initial.messages.push({ info: { messageId: 'u1', sessionId: 'sess_native', role: 'user', time: { created: 100 },
    metadata: { inputIntent: { inputOrigin: 'desktop', sourceCommandId: 'desktop-command' } } }, parts: [{ type: 'text', text: 'hi222' }] });
  await writeFile(data, JSON.stringify(initial));
  expect((await reader.read('sess_native')).turns[0]).toMatchObject({ input: 'hi222', bridge: false });
  expect(nativeStop).not.toHaveBeenCalled();
  expect(await reader.stopTurn!('sess_native', 'different-message')).toBe(false);
  expect(await reader.stopTurn!('sess_native', 'u1')).toBe(true);
  expect(nativeStop).toHaveBeenCalledWith('sess_native', 'u1', dir);
  initial.messages[0].info.metadata.inputIntent.inputOrigin = 'mobile'; await writeFile(data, JSON.stringify(initial));
  expect(await reader.stopTurn!('sess_native', 'u1')).toBe(true);
  expect(nativeStop).toHaveBeenCalledTimes(2);
  initial.messages[0].info.metadata.inputIntent.sourceCommandId = 'bridge-test'; await writeFile(data, JSON.stringify(initial));
  expect(await reader.stopTurn!('sess_native', 'u1')).toBe(false);
  expect(nativeStop).toHaveBeenCalledTimes(2);
  initial.session.sessionId = 'sess_wrong'; await writeFile(data, JSON.stringify(initial));
  await expect(reader.read('sess_native')).rejects.toThrow('读取失败');
  await expect(reader.read('../file')).rejects.toThrow('ID 无效');
});
