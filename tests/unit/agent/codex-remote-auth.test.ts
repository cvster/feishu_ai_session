import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { buildCodexQueueArgs } from '../../../src/agent/codex/argv.js';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { CodexThreadReader } from '../../../src/session/codex-thread-reader.js';

/** A protected loopback endpoint that rejects handshakes without the bearer token. */
async function protectedEndpoint(token: string) {
  return await loopbackEndpoint((authorization) => authorization === `Bearer ${token}`);
}

/** A loopback endpoint like the launcher-managed unauthenticated shared server. */
async function openEndpoint() {
  return await loopbackEndpoint(() => true);
}

async function loopbackEndpoint(isAllowed: (authorization: string | undefined) => boolean) {
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    verifyClient: (info, done) => done(isAllowed(info.req.headers.authorization), 401, 'Unauthorized'),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test endpoint address');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: { userAgent: 'protected-test' } }));
      else if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: { account: null } }));
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Codex protected WebSocket authentication', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('passes the token environment variable name to the queue CLI, never the token', () => {
    expect(buildCodexQueueArgs({ cwd: '/repo', sandbox: 'workspace-write', threadId: 'thread-1',
      prompt: 'hello', remote: 'ws://127.0.0.1:4500', remoteTokenEnv: 'CODEX_QUEUE_REMOTE_TOKEN' }))
      .toEqual(['queue', '--remote', 'ws://127.0.0.1:4500',
        '--remote-auth-token-env', 'CODEX_QUEUE_REMOTE_TOKEN', '--thread', 'thread-1', '--message', 'hello']);
  });

  it('rejects a token environment variable without a remote endpoint', () => {
    expect(() => buildCodexQueueArgs({ cwd: '/repo', sandbox: 'workspace-write',
      threadId: 'thread-1', prompt: 'hello', remoteTokenEnv: 'CODEX_QUEUE_REMOTE_TOKEN' }))
      .toThrow('requires a remote endpoint');
  });

  it('authenticates the reader handshake from the configured environment variable', async () => {
    const endpoint = await protectedEndpoint('test-bearer-token');
    const dir = await mkdtemp(join(tmpdir(), 'codex-remote-auth-')); cleanup.push(dir);
    const reader = new CodexThreadReader({ binary: 'codex-not-spawned', profileStateDir: dir,
      sharedServer: true, remote: endpoint.url, remoteTokenEnv: 'BRIDGE_TEST_CODEX_TOKEN',
      env: { BRIDGE_TEST_CODEX_TOKEN: 'test-bearer-token' }, timeoutMs: 5_000 });
    try {
      await reader.connect();
      await expect(reader.rpc('account/read', { refreshToken: false })).resolves.toEqual({ account: null });
    } finally {
      await reader.stop();
      await endpoint.close();
    }
  });

  it('connects to an unauthenticated loopback endpoint without demanding a token', async () => {
    const endpoint = await openEndpoint();
    const dir = await mkdtemp(join(tmpdir(), 'codex-remote-auth-')); cleanup.push(dir);
    const reader = new CodexThreadReader({ binary: 'codex-not-spawned', profileStateDir: dir,
      sharedServer: true, remote: endpoint.url, env: {}, timeoutMs: 5_000 });
    try {
      await reader.connect();
      await expect(reader.rpc('account/read', { refreshToken: false })).resolves.toEqual({ account: null });
    } finally {
      await reader.stop();
      await endpoint.close();
    }
  });

  it('does not infer a token requirement for a plain ws:// endpoint', () => {
    const adapter = new CodexAdapter({ binary: 'codex-not-spawned', profileStateDir: 'unused',
      appServerRemote: 'ws://127.0.0.1:4517' });
    expect((adapter as unknown as { appServerRemoteTokenEnv?: string }).appServerRemoteTokenEnv).toBeUndefined();
  });

  it('fails closed when the token variable is missing or empty', async () => {
    const endpoint = await protectedEndpoint('test-bearer-token');
    const dir = await mkdtemp(join(tmpdir(), 'codex-remote-auth-')); cleanup.push(dir);
    const reader = new CodexThreadReader({ binary: 'codex-not-spawned', profileStateDir: dir,
      sharedServer: true, remote: endpoint.url, remoteTokenEnv: 'BRIDGE_TEST_MISSING_TOKEN',
      env: {}, timeoutMs: 5_000 });
    try {
      await expect(reader.connect()).rejects.toThrow('BRIDGE_TEST_MISSING_TOKEN');
    } finally {
      await reader.stop();
      await endpoint.close();
    }
  });

  it('refuses a token environment variable for a non-WebSocket endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-remote-auth-')); cleanup.push(dir);
    const reader = new CodexThreadReader({ binary: 'codex-not-spawned', profileStateDir: dir,
      sharedServer: true, remote: 'unix://', remoteTokenEnv: 'BRIDGE_TEST_CODEX_TOKEN',
      env: { BRIDGE_TEST_CODEX_TOKEN: 'test-bearer-token' }, timeoutMs: 5_000 });
    try {
      await expect(reader.connect()).rejects.toThrow('only supported for ws:// or wss://');
    } finally {
      await reader.stop();
    }
  });
});
