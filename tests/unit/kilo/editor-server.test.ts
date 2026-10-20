import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { findKiloEditorServer } from '../../../src/agent/kilo/editor-server';

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kilo-editor-')); clean.push(() => rm(root, { recursive: true, force: true }));
  const procRoot = join(root, 'proc'), cwd = join(root, 'project'), dataHome = join(root, 'data');
  await mkdir(cwd); await mkdir(procRoot);
  let calls = 0, healthy = true;
  const server = createServer((req, res) => { calls++;
    expect(req.url).toBe('/global/health'); expect(req.headers.authorization).toBe('Basic '+Buffer.from('kilo:private-editor-password').toString('base64'));
    res.writeHead(healthy ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ healthy }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  clean.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const port = (server.address() as { port: number }).port;
  async function processEntry(id: number, overrides: { uid?: number; env?: NodeJS.ProcessEnv; cwd?: string; address?: string } = {}) {
    const path = join(procRoot, String(id)); await mkdir(join(path, 'fd'), { recursive: true }); await mkdir(join(path, 'net'));
    const uid = overrides.uid ?? 1000;
    await symlink(process.execPath, join(path, 'exe')); await symlink(overrides.cwd ?? cwd, join(path, 'cwd'));
    await writeFile(join(path, 'status'), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nPPid:\t42\n`);
    await writeFile(join(path, 'cmdline'), ['kilo', 'serve', '--port', '0', ''].join('\0'));
    await writeFile(join(path, 'environ'), Object.entries({ XDG_DATA_HOME: dataHome, KILO_CLIENT: 'vscode', KILO_PARENT_PID: '42',
      KILO_SERVER_PASSWORD: 'private-editor-password', ...overrides.env }).map(([k, v]) => `${k}=${v}`).join('\0'));
    await symlink('socket:[12345]', join(path, 'fd/10'));
    await writeFile(join(path, 'net/tcp'), `header\n0: ${overrides.address ?? '0100007F'}:${port.toString(16).toUpperCase()} 00000000:0000 0A 0:0 0:0 0 1000 0 12345\n`);
  }
  const discover = (path = cwd) => findKiloEditorServer(process.execPath, path, dataHome, { procRoot, uid: 1000, platform: 'linux' });
  return { cwd, dataHome, root, processEntry, discover, calls: () => calls, unhealthy: () => { healthy = false; } };
}
it('authenticates an editor-owned same-user server for the same database and workspace', async () => {
  const h = await fixture(); await h.processEntry(100);
  expect(await h.discover()).toMatchObject({ pid: 100, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
  expect(h.calls()).toBe(1);
});
it.each([
  { uid: 2000 }, { env: { KILO_CLIENT: 'cli' } }, { env: { KILO_SERVER_PASSWORD: '' } },
  { env: { KILO_PARENT_PID: '99' } }, { env: { XDG_DATA_HOME: '/different/account' } },
  { env: { KILO_DB: ':memory:' } }, { env: { KILO_DB: '/different/database.db' } }, { address: '00000000' },
])('ignores non-matching or untrusted editor processes: %j', async overrides => {
  const h = await fixture(); await h.processEntry(100, overrides); expect(await h.discover()).toBeUndefined(); expect(h.calls()).toBe(0);
});
it('does not match a sibling directory with the same name prefix', async () => {
  const h = await fixture(); await h.processEntry(100); const other = h.cwd+'-other'; await mkdir(other);
  expect(await h.discover(other)).toBeUndefined(); expect(h.calls()).toBe(0);
});
it('prefers an exact workspace over an editor of a parent folder', async () => {
  const h = await fixture(); await h.processEntry(100, { cwd: h.root }); await h.processEntry(101);
  expect((await h.discover())?.pid).toBe(101); expect(h.calls()).toBe(1);
});
it('refuses ambiguous editors before sending any request', async () => {
  const h = await fixture(); await h.processEntry(100); await h.processEntry(101);
  await expect(h.discover()).rejects.toThrow('多个 Kilo 编辑器后端'); expect(h.calls()).toBe(0);
});
it('fails closed when the chosen editor is unhealthy, without exposing its credentials', async () => {
  const h = await fixture(); await h.processEntry(100); h.unhealthy();
  await expect(h.discover()).rejects.toThrow('健康检查失败'); expect(h.calls()).toBe(1);
});
