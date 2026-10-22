import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { loadRootConfig, runtimeProfileConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { resolveAppSecret } from '../../../src/config/secret-resolver';
import { createDirectLarkHttpInstance } from '../../../src/platform/lark-http';
import { discoverWorkers } from '../../../src/worker/discovery';
import { loadRuntimeEnv } from '../../../src/config/runtime-env';
import { lockLiveSuite, runLiveWorkerScenario } from '../../helpers/live-worker-scenario';

const enabled = process.env.BRIDGE_LIVE_SMOKE === '1';
const root = resolve(process.env.BRIDGE_LIVE_HOME ?? join(homedir(), '.lark-channel'));
const config = enabled ? await loadRootConfig(join(root, 'config.json')) : undefined;
const profile = process.env.BRIDGE_LIVE_PROFILE ?? config?.activeProfile;
const selected = profile ? config?.profiles[profile] : undefined;
const profileDir = join(root, 'profiles', profile ?? 'unused');
if (enabled && profile) await loadRuntimeEnv(profile, root);
const workers = selected ? await discoverWorkers(profileDir, selected.accounts.app.id) : [];
const requested = (process.env.BRIDGE_LIVE_TOOLS ?? 'codex,zcode,kilo').split(',').filter(Boolean);
const targets = workers.filter(w => !requested || requested.includes(w.health.toolId));
if (enabled && (!selected || !targets.length || requested.some(id => !targets.some(w => w.health.toolId === id))))
  throw new Error('Requested live profile/workers are unavailable; no test passed or artifact created');
describe.skipIf(!enabled)('deployed worker / native tool / Feishu integration', () => {
  let release: (() => Promise<void>) | undefined;
  let channel: LarkChannel;
  beforeAll(async () => {
    release = await lockLiveSuite(profileDir);
    const cfg = runtimeProfileConfig(config!, profile!);
    channel = createLarkChannel({ appId: selected!.accounts.app.id,
      appSecret: await resolveAppSecret(cfg, resolveAppPaths({ rootDir: root, profile })),
      domain: selected!.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
      httpInstance: createDirectLarkHttpInstance(30_000), respectProxyEnv: false,
      // SDK transport errors may contain request credentials. The scenario
      // records safe failure messages and verified cleanup progress itself.
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
  });
  afterAll(async () => { await release?.(); });
  it.each(targets.map(worker => [worker.health.toolId, worker] as const))('%s synchronizes messages and names both ways, then archives its autotest session and dissolves the muted group', async (_id, worker) => {
    const workspace = process.env.BRIDGE_LIVE_WORKSPACE ?? selected!.workspaces.default ?? process.cwd();
    const result = await runLiveWorkerScenario(worker, profileDir, workspace, channel);
    expect(result.passed).toBe(true); expect(result.cleaned).toBe(true);
    console.log(`[live:${worker.health.toolId}] report: ${result.reportPath}`);
  }, 600_000);
});
