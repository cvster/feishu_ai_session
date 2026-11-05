import { mkdtemp, readFile, readdir, writeFile, chmod, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentDefaultStore, isStorableModel } from '../../../src/agent/defaults';

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import('node:fs/promises'); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function store(contents?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-defaults-')); dirs.push(dir);
  const path = join(dir, 'agent-defaults.json');
  if (contents !== undefined) await writeFile(path, contents);
  const created = new AgentDefaultStore(path); await created.load();
  return { path, dir, defaults: created };
}

it('starts empty when the file is missing and round-trips one entry per tool', async () => {
  const { path, defaults } = await store();
  expect(defaults.get('kilo')).toBeUndefined(); expect(defaults.brokenReason).toBeUndefined();
  await defaults.set('kilo', 'provider/one'); await defaults.set('pi', 'p/two');
  expect(defaults.get('kilo')).toBe('provider/one');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { kilo: 'provider/one', pi: 'p/two' } });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await defaults.set('kilo', undefined);
  expect(defaults.get('kilo')).toBeUndefined();
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { pi: 'p/two' } });
});

it('keeps entries it cannot validate so a later save never deletes them', async () => {
  const { path, defaults } = await store(JSON.stringify({ version: 1, models: { kilo: '-flag', pi: 'p/one', weird: 7, '': 'x' } }));
  expect(defaults.get('kilo')).toBeUndefined(); expect(defaults.get('pi')).toBe('p/one');
  await defaults.set('dsh', 'd/one');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { kilo: '-flag', weird: 7, '': 'x', pi: 'p/one', dsh: 'd/one' } });
});

it('never exposes inherited object keys as tool defaults', async () => {
  const { defaults } = await store('{"version":1,"models":{"__proto__":"a/b","constructor":"c/d"}}');
  expect(defaults.get('__proto__')).toBe('a/b');
  expect(defaults.get('constructor')).toBe('c/d');
  expect(defaults.get('toString')).toBeUndefined();
  await defaults.set('kilo', 'k/one');
  expect(defaults.get('toString')).toBeUndefined();
});

it('isolates a corrupt file and keeps working', async () => {
  const { path, dir, defaults } = await store('{ not json');
  expect(defaults.brokenReason).toBeUndefined(); expect(defaults.get('kilo')).toBeUndefined();
  const files = await readdir(dir);
  expect(files.some(name => name.startsWith('agent-defaults.json.corrupt-'))).toBe(true);
  expect(files).not.toContain('agent-defaults.json');
  await defaults.set('kilo', 'k/one');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { kilo: 'k/one' } });
});

it('refuses to write over a file it cannot interpret', async () => {
  for (const contents of [JSON.stringify({ version: 2, models: { kilo: 'k/one' } }), JSON.stringify({ version: 1, models: ['k/one'] }), 'null']) {
    const { path, defaults } = await store(contents);
    expect(defaults.brokenReason).toBeTruthy();
    expect(defaults.get('kilo')).toBeUndefined();
    await expect(defaults.set('kilo', 'k/two')).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(contents);
  }
});

it('enters read-only mode when the file cannot be read at all', async () => {
  const { path } = await store();
  await mkdir(path);
  const defaults = new AgentDefaultStore(path); await defaults.load();
  expect(defaults.brokenReason).toBe('默认模型配置无法读取');
  await expect(defaults.set('kilo', 'k/one')).rejects.toThrow('默认模型配置无法读取');
  expect((await stat(path)).isDirectory()).toBe(true);
});

it('rejects a failed write without changing what the next run uses, and recovers afterwards', async () => {
  const { path, dir, defaults } = await store();
  await defaults.set('kilo', 'k/one');
  await chmod(dir, 0o500);
  await expect(defaults.set('kilo', 'k/two')).rejects.toThrow();
  expect(defaults.get('kilo')).toBe('k/one');
  await chmod(dir, 0o700);
  await defaults.set('kilo', 'k/two');
  expect(defaults.get('kilo')).toBe('k/two');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { kilo: 'k/two' } });
});

it('serialises concurrent writes so the last one wins on disk too', async () => {
  const { path, defaults } = await store();
  await Promise.all([defaults.set('kilo', 'k/one'), defaults.set('kilo', 'k/two'), defaults.set('pi', 'p/one')]);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: { kilo: 'k/two', pi: 'p/one' } });
});

it('only accepts tokens a CLI can take as a model argument', () => {
  for (const value of ['provider/model', 'a', 'p/m/x']) expect(isStorableModel(value)).toBe(true);
  for (const value of ['', ' a/b', 'a/b ', '-flag', 'a\nb', 'x'.repeat(513), 5, null, undefined]) expect(isStorableModel(value)).toBe(false);
});
