import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listClaudeModels } from '../../src/agent/claude/models';
import { readCodexModels } from '../../src/agent/codex/models';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('reads every Codex page, uses native slugs and labels, and excludes hidden entries', async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: [{ id: 'ui-id', model: 'new-slug', displayName: 'Native label' }, { model: 'hidden', hidden: true }], nextCursor: 'page2' })
    .mockResolvedValueOnce({ data: [{ model: 'vendor/another', displayName: 'Another' }], nextCursor: null });
  expect(await readCodexModels({ rpc })).toEqual([{ value: 'new-slug', label: 'Native label' }, { value: 'vendor/another', label: 'Another' }]);
  expect(rpc.mock.calls[1]).toEqual(['model/list', { cursor: 'page2', limit: 100, includeHidden: false }]);
  rpc.mockResolvedValue({ data: [], nextCursor: 'loop' });
  await expect(readCodexModels({ rpc })).rejects.toThrow('游标重复');
  expect(rpc.mock.calls.every(call => call[0] === 'model/list')).toBe(true);
});
it('queries Claude initialize without a prompt and rereads models from the same tool after changes', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(join(tmpdir(), 'claude-catalog-')); roots.push(dir);
  const binary = join(dir, 'claude'), state = join(dir, 'models.json'), calls = join(dir, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nrequire('node:readline').createInterface({input:process.stdin}).on('line', line => {
    fs.appendFileSync(${JSON.stringify(calls)}, line+'\\n'); const q = JSON.parse(line);
    process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:q.request_id,response:{models:JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'))}}})+'\\n');
  });`, { mode: 0o700 });
  await writeFile(state, JSON.stringify([{ value: 'custom-alias[1m]', displayName: 'Custom native label' }]));
  expect(await listClaudeModels(binary, dir)).toEqual([{ value: 'custom-alias[1m]', label: 'Custom native label' }]);
  await writeFile(state, JSON.stringify([{ value: 'new-release', displayName: 'New release' }]));
  expect(await listClaudeModels(binary, dir)).toEqual([{ value: 'new-release', label: 'New release' }]);
  const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
  expect(requests.some(request => request.type === 'user')).toBe(false);
});
