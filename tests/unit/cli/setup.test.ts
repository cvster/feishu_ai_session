import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ runtime: vi.fn(), preflight: vi.fn(async () => {}) }));
vi.mock('../../../src/runtime/profile-runtime', () => ({ resolveProfileRuntime: mocks.runtime }));
vi.mock('../../../src/cli/preflight', () => ({ preFlightChecks: mocks.preflight }));
import { runSetup } from '../../../src/cli/commands/setup';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); vi.clearAllMocks(); });
async function context() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-setup-')); roots.push(root);
  const path = join(root, 'lark.json');
  mocks.runtime.mockResolvedValue({ cfg: { accounts: { app: { id: 'cli_test', tenant: 'feishu' } } }, profileConfig: {}, configPath: join(root, 'config.json'),
    appPaths: { profile: 'test', rootDir: root, larkCliTargetConfigFile: path } });
  return path;
}
it('fails setup when non-interactive preflight returned without installing/binding lark-cli', async () => {
  await context();
  await expect(runSetup({ profile: 'test' })).rejects.toThrow('绑定尚未完成');
  expect(mocks.runtime).toHaveBeenCalledWith({ profile: 'test', allowBootstrap: false });
});
it('requires the correct app and tenant before declaring setup complete', async () => {
  const path = await context();
  await writeFile(path, JSON.stringify({ apps: [{ appId: 'other', brand: 'feishu' }] }));
  await expect(runSetup({ profile: 'test' })).rejects.toThrow('绑定尚未完成');
  await writeFile(path, JSON.stringify({ apps: [{ appId: 'cli_test', brand: 'feishu' }] }));
  await expect(runSetup({ profile: 'test' })).resolves.toBeUndefined();
});
