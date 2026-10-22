import { randomUUID } from 'node:crypto';
import { CodexThreadReader } from '../../src/session/codex-thread-reader';
import { KiloClient } from '../../src/agent/kilo/client';
import { ZcodeRemoteClient } from '../../src/agent/zcode/remote-client';
import { zcodeDesktopCredentialFile } from '../../src/agent/zcode/remote-auth';
import { createPersistedCodexThread } from '../../packages/codex-core/src/lifecycle';

/** Direct native input, intentionally outside worker jobs and bridge provenance. */
export interface LiveNativeDriver {
  create(name: string, record: (id: string) => Promise<void>): Promise<string>;
  validate(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  send(id: string, text: string): Promise<void>;
  archive(id: string): Promise<void>;
  isArchived(id: string): Promise<boolean>;
  close(): Promise<void>;
}
export function liveNativeDriver(toolId: string, options: Record<string, any>, sourceId: string,
  stateDir: string, cwd: string): LiveNativeDriver {
  if (toolId === 'codex') {
    const reader = new CodexThreadReader({ binary: options.binaryPath ?? 'codex', profileStateDir: stateDir,
      codexHome: sourceId, inheritCodexHome: true, remote: options.appServerRemote, sharedServer: true, passive: true });
    return {
      create: (name, record) => createPersistedCodexThread({ request: async (method, params) => {
        const result = await reader.rpc(method, params);
        if (method === 'thread/start' && typeof (result.thread as any)?.id === 'string')
          await record((result.thread as any).id);
        return result;
      } }, { cwd, name, sandbox: 'read-only', threadSource: 'user' }),
      validate: async id => {
        if ((await reader.listArchivedThreadIds()).includes(id)) throw new Error('Recorded Codex session is archived');
        const value = await reader.rpc('thread/read', { threadId: id, includeTurns: false });
        if ((value.thread as any)?.id !== id || (value.thread as any)?.cwd !== cwd) throw new Error('Recorded Codex session is missing or has a different workspace');
      },
      rename: async (id, name) => { await reader.rpc('thread/name/set', { threadId: id, name }); },
      send: async (id, text) => { await reader.addQueuedSubmission({ threadId: id, prompt: text,
        submissionId: randomUUID(), clientUserMessageId: `autotest-native:${randomUUID()}` }); },
      archive: async id => { await reader.rpc('thread/archive', { threadId: id }); },
      isArchived: async id => (await reader.listArchivedThreadIds()).includes(id),
      close: () => reader.stop(),
    };
  }
  if (toolId === 'kilo') {
    const client = new KiloClient({ ...options, binary: options.binaryPath }, cwd);
    return {
      create: async (name, record) => {
        const id = (await client.request('POST', '/session', { title: name,
          permission: [{ permission: '*', pattern: '*', action: 'deny' }] }, cwd)).id;
        if (typeof id !== 'string' || !id) throw new Error('Kilo creation returned no native ID');
        await record(id); return id;
      },
      validate: async id => { const row = await client.request('GET', `/session/${id}`, undefined, cwd);
        if (row.id !== id || row.directory !== cwd || row.time?.archived) throw new Error('Recorded Kilo session is missing, archived or has a different workspace'); },
      rename: async (id, name) => { await client.request('PATCH', `/session/${id}`, { title: name }, cwd); },
      archive: async id => { await client.request('PATCH', `/session/${id}`, { time: { archived: Date.now() } }, cwd); },
      isArchived: async id => { const row = await client.request('GET', `/session/${id}`, undefined, cwd);
        if (row.id !== id || row.directory !== cwd) throw new Error('Kilo archive verification identity mismatch');
        return !!row.time?.archived; },
      send: async (id, text) => {
        const session = await client.request('GET', `/session/${id}`, undefined, cwd);
        const messages = await client.request('GET', `/session/${id}/message`, undefined, cwd);
        const last = [...messages].reverse().find(row => row.info?.role === 'user' && !row.info?.synthetic);
        const model = session.model?.providerID && session.model?.id
          ? { providerID: session.model.providerID, modelID: session.model.id } : last?.info?.model;
        await client.request('POST', `/session/${id}/prompt_async`, {
          parts: [{ type: 'text', text }],
          ...(model?.providerID && model?.modelID ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        }, cwd);
      },
      close: () => client.close(),
    };
  }
  if (toolId === 'zcode') {
    if (!options.remoteControlFile) throw new Error('ZCode native name tests require desktop pairing');
    // Open only during an operation. The worker owns this pairing during its
    // jobs and name polling; native tests never hold it across Feishu input.
    const withClient = async <T>(fn: (client: ZcodeRemoteClient) => Promise<T>): Promise<T> => {
      const client = new ZcodeRemoteClient(options.remoteControlFile, cwd, undefined,
        zcodeDesktopCredentialFile(options.modelConfigPath));
      try { return await fn(client); } finally { await client.close(); }
    };
    return {
      create: (_name, record) => withClient(async client => {
        const snapshot = await client.request('session/create', { mode: 'plan' });
        const id = snapshot.session?.sessionId;
        if (typeof id !== 'string') throw new Error('ZCode creation returned no native ID');
        await record(id);
        // ZCode materializes an empty session on its first input. The scenario
        // seeds that history before assigning the final name.
        return id;
      }),
      validate: id => withClient(async client => { const row = await client.request('session/read', { sessionId: id });
        if (row.session?.sessionId !== id || row.session?.archivedAt || row.session?.workspace?.workspacePath !== cwd ||
          await client.isNativeTaskArchived(id))
          throw new Error('Recorded ZCode session is missing, archived or has a different workspace'); }),
      rename: (id, name) => withClient(async client => { await client.request('session/rename', { sessionId: id, title: name }); }),
      archive: id => withClient(async client => { await client.request('session/archive', { sessionId: id }); }),
      isArchived: id => withClient(client => client.isNativeTaskArchived(id)),
      send: (id, text) => withClient(async client => {
        const snapshot = await client.request('session/read', { sessionId: id });
        const current = snapshot.settings?.model?.current;
        const model = current?.ref ?? current;
        if (!model?.providerId || !model?.modelId) throw new Error('ZCode session has no selected native model');
        await client.sendNativeText(id, text, model);
      }),
      close: async () => {},
    };
  }
  throw new Error(`Native live driver is not implemented for ${toolId}`);
}
