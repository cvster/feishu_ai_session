import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';
import { runZcodePair } from '../../../src/cli/commands/zcode-remote';

const remote = vi.hoisted(() => ({ credentialFile: '', request: vi.fn(async () => ({})), close: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/zcode/remote-client', async importOriginal => {
  const real = await importOriginal<typeof import('../../../src/agent/zcode/remote-client')>();
  return { ...real, ZcodeRemoteClient: class {
    constructor(_file: string, _workspace: string, _relay: string | undefined, credentialFile: string) { remote.credentialFile = credentialFile; }
    request = remote.request;
    close = remote.close;
  } };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('updates canonical worker pairing settings and validates using its credential source after migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-pair-')); roots.push(root);
  const profile = createDefaultProfileConfig({ agentKind: 'zcode', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } } });
  const config = join(root, 'custom-config.json'), rootText = JSON.stringify(createRootConfig('test', profile));
  await writeFile(config, rootText);
  const directory = join(root, 'profiles', 'test', 'workers', 'zcode'); await mkdir(directory, { recursive: true });
  const workerFile = join(directory, 'config.json');
  const options = { binaryPath: '/existing/node', args: ['/existing/zcode.cjs'], modelConfigPath: join(root, 'desktop-config'), dataDir: '/original/native-source', remoteControlFile: '/old/link' };
  await writeFile(workerFile, JSON.stringify({ version: 1, toolId: 'zcode', options }));
  const link = 'https://zcode.z.ai/remote/v4?sid=device-1&app_version=3.16.2';
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(link); });
  await runZcodePair({ config, profile: 'test', workspace: root });
  const saved = JSON.parse(await readFile(workerFile, 'utf8'));
  expect(saved.options).toMatchObject({ ...options, remoteControlFile: expect.stringContaining('zcode-remote-') });
  expect(await readFile(saved.options.remoteControlFile, 'utf8')).toBe(link + '\n');
  if (process.platform !== 'win32') expect((await stat(saved.options.remoteControlFile)).mode & 0o777).toBe(0o600);
  expect(remote.credentialFile).toBe(join(root, 'desktop-config', 'credentials.json'));
  expect(remote.request).toHaveBeenCalledWith('workspace/updateProviderRegistry', {});
  expect(remote.close).toHaveBeenCalledOnce();
  expect(await readFile(config, 'utf8')).toBe(rootText);
});
