import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
