import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const run = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('refreshes all identities together and preserves the document on failed or incomplete queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'permission-refresh-')); roots.push(root);
  for (const dir of ['tools', 'docs', 'bin']) await mkdir(join(root, dir));
  const script = join(root, 'tools/update-feishu-permissions.mjs'), doc = join(root, 'docs/FEISHU_PERMISSIONS.md');
  await cp(new URL('../../../tools/update-feishu-permissions.mjs', import.meta.url), script);
  await writeFile(doc, 'Manual instructions\n<!-- feishu-permissions:start -->\nold\n<!-- feishu-permissions:end -->\nManual footer\n');
  await writeFile(join(root, 'bin/lark-cli'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '--profile' || args[1] !== 'cli_test') process.exit(2);
if (args.includes('whoami')) console.log(JSON.stringify({appId:'cli_test', identity:'bot', available:true}));
else if (process.env.FIXTURE_FAILURE) { console.error('credential must stay private'); process.exit(1); }
else console.log(JSON.stringify({app_id:process.env.FIXTURE_MISMATCH ? 'cli_other' : 'cli_test', app_name:'Test', scopes:process.env.FIXTURE_EMPTY ? [] : [
 {scope:'z:write', description:'User | name', token_types:['user']},
 {scope:'a:read', description:'Bot', token_types:['tenant']},
 {scope:'a:read', description:'Both', token_types:['user']}
]}));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
  const args = [script, '--profile', 'cli_test'];
  const before = await readFile(doc, 'utf8');
  await expect(run(process.execPath, [...args, '--check'], { env })).rejects.toMatchObject({ code: 1 });
  expect(await readFile(doc, 'utf8')).toBe(before);
  await run(process.execPath, args, { env });
  const updated = await readFile(doc, 'utf8');
  expect(updated).toContain('**2 项**');
  expect(updated).toContain('| `a:read` | Both | 应用 / 机器人、用户 |');
  expect(updated).toContain('User &#124; name');
  expect(updated.indexOf('`a:read`')).toBeLessThan(updated.indexOf('`z:write`'));
  expect(updated.startsWith('Manual instructions\n')).toBe(true);
  expect(updated.endsWith('Manual footer\n')).toBe(true);
  await run(process.execPath, [...args, '--check'], { env });
  for (const key of ['FIXTURE_FAILURE', 'FIXTURE_EMPTY', 'FIXTURE_MISMATCH']) {
    try { await run(process.execPath, args, { env: { ...env, [key]: '1' } }); throw new Error('expected rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 1 }); expect(String(error)).not.toContain('credential must stay private'); }
    expect(await readFile(doc, 'utf8')).toBe(updated);
  }
});
