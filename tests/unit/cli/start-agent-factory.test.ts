import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';

describe('start runtime agent factory', () => {
  it.each(['claude', 'codex', 'kilo', 'zcode', 'dsh', 'custom'])('constructs only a worker transport for %s', toolId => {
    const agent = createRuntimeAgent(createDefaultProfileConfig({ agentKind: toolId, accounts: appAccount() }), { profileDir: tmpdir() });
    expect(agent.id).toBe(toolId);
    expect((agent as import('../../../src/worker/adapter').DurableAgentAdapter).client.stateDir).toBe(join(tmpdir(), 'workers', toolId));
    expect('binary' in agent).toBe(false);
  });
  it('bootstraps without provider configuration or an installed CLI', () => {
    vi.stubEnv('LARK_CHANNEL_CODEX_BIN', '/unavailable');
    const profile = createRuntimeProfileConfig({ agentKind: 'kilo', accounts: appAccount() });
    expect(profile.codex).toBeUndefined(); expect(profile.kilo).toBeUndefined();
    vi.unstubAllEnvs();
  });
  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const restartStart = source.indexOf('async restart()');
    const updateIndex = source.indexOf('await updateEntry(entry.id', restartStart);
    const releaseIndex = source.indexOf('await oldAppLock?.release()', restartStart);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(releaseIndex);
  });

  it('releases the current runtime locks during graceful shutdown', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const stopStart = source.indexOf('const stop = async');
    const releaseIndex = source.indexOf('await releaseRuntimeLocks(runtimeLocks)', stopStart);
    const exitIndex = source.indexOf('process.exit(0)', stopStart);

    expect(stopStart).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(exitIndex);
  });

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
  });
});

function appAccount() {
  return {
    app: {
      id: 'cli_xxx',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}

function codexConfig() {
  return {
    binaryPath: '/usr/local/bin/codex',
    realpath: '/usr/local/bin/codex',
    version: 'codex 1.2.3',
    sha256: '0'.repeat(64),
    owner: 501,
    mode: 0o755,
  };
}
