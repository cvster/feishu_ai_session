import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { configureGroupNotifications, muteSessionGroup } from '../../../src/bot/group-notifications';
import { spawnProcess } from '../../../src/platform/spawn';

vi.mock('../../../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('uses the main owner CLI profile while preserving the agent bot-only configuration', async () => {
  vi.stubEnv('LARK_CHANNEL', '1');
  vi.stubEnv('LARK_CHANNEL_PROFILE', 'agent');
  vi.stubEnv('LARK_CHANNEL_HOME', '/private/agent');
  vi.stubEnv('LARK_CHANNEL_CONFIG', '/private/agent/config.json');
  vi.stubEnv('LARKSUITE_CLI_CONFIG_DIR', '/private/agent/cli');
  vi.stubEnv('LARK_CHANNEL_OWNER_CLI_CONFIG_DIR', '/owner/cli');
  const inputs: string[] = [];
  vi.mocked(spawnProcess).mockImplementation((_cmd, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    let input = '';
    child.stdin.on('data', chunk => { input += chunk.toString(); });
    child.stdin.on('finish', () => {
      inputs.push(input);
      const data = args?.includes('auth')
        ? { appId: 'cli_owner', identities: { user: { available: true, openId: 'ou_owner' } } }
        : { ok: true, identity: 'user', data: {} };
      child.stdout.end(JSON.stringify(data)); child.emit('close', 0);
    });
    return child as never;
  });
  const channel = {} as never;
  configureGroupNotifications(channel, { appId: 'cli_owner', ownerId: () => 'ou_owner' });
  await muteSessionGroup(channel, 'oc_ff');
  expect(spawnProcess).toHaveBeenCalledTimes(2);
  for (const [command, args, options] of vi.mocked(spawnProcess).mock.calls) {
    expect(command).toBe('lark-cli');
    expect(args?.slice(0, 2)).toEqual(['--profile', 'cli_owner']);
    expect(options?.env?.LARKSUITE_CLI_CONFIG_DIR).toBe('/owner/cli');
    for (const key of ['LARK_CHANNEL', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_CONFIG'])
      expect(options?.env).not.toHaveProperty(key);
    expect(options?.stdio).toEqual(['pipe', 'pipe', 'ignore']);
  }
  expect(JSON.parse(inputs[1]!)).toEqual({ chat_settings: [{ chat_id: 'oc_ff', is_muted: true }] });
  expect(process.env.LARKSUITE_CLI_CONFIG_DIR).toBe('/private/agent/cli');
});
