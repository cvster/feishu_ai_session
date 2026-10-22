import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadRootConfig } from '../../../src/config/profile-store';
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
describe.skipIf(!enabled)('deployed worker / native tool / Feishu integration', () => {
  let release: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (!selected || !targets.length || requested?.some(id => !targets.some(w => w.health.toolId === id)))
      throw new Error('Requested live profile/workers are unavailable; no test passed or artifact created');
    release = await lockLiveSuite(profileDir);
  });
  afterAll(async () => { await release?.(); });
  it.each(targets.map(worker => [worker.health.toolId, worker] as const))('%s reuses its autotest session, auto-creates a muted group and synchronizes messages and names both ways', async (_id, worker) => {
    const workspace = process.env.BRIDGE_LIVE_WORKSPACE ?? selected!.workspaces.default ?? process.cwd();
    const result = await runLiveWorkerScenario(worker, profileDir, workspace);
    expect(result.passed).toBe(true); expect(result.restored).toBe(true);
    console.log(`[live:${worker.health.toolId}] report: ${result.reportPath}`);
  }, 600_000);
});
