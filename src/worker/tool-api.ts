import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentAdapter } from '../agent/types';
import type { WorkerCapabilities, WorkerErrorCode, WorkerSessionService } from './protocol';

export class WorkerApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: WorkerErrorCode,
    readonly retryable = status === 429 || status === 503) { super(message); }
}
export interface WorkerToolApi {
  agent: AgentAdapter;
  sessions?: WorkerSessionService;
  /** Paired transports must not replace a connection owned by an active job. */
  connectionExclusive: boolean;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  assertIdle(nativeId?: string): void;
}
export function workerCapabilities(api: Pick<WorkerToolApi, 'agent' | 'sessions'>): WorkerCapabilities {
  return { apiVersion: 2, jobs: { submit: true, read: true, stop: true, eventCursor: true },
    models: typeof api.agent.listModels === 'function',
    sessions: { list: !!api.sessions, history: !!api.sessions,
      rename: !!api.sessions?.rename || typeof api.agent.renameSession === 'function',
      archive: !!api.sessions?.archive, fork: !!api.sessions?.fork },
    nativeTurnStop: typeof api.agent.stopNativeTurn === 'function' &&
      (!('desktopRemoteEnabled' in api.agent) || api.agent.desktopRemoteEnabled === true) };
}
function required(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new WorkerApiError(400, `Invalid ${field}`, 'invalid-request');
  return value;
}
export async function readWorkerBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new WorkerApiError(413, 'Request too large', 'invalid-request');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new WorkerApiError(400, 'Invalid JSON object', 'invalid-request'); }
}
const unsupported = () => { throw new WorkerApiError(501, 'Worker does not support this operation', 'unsupported-operation'); };
function reply(res: ServerResponse, value: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}

/** All workers expose the same routes; capabilities decide support, not tool IDs. */
export async function handleWorkerToolRequest(req: IncomingMessage, res: ServerResponse, url: URL, api: WorkerToolApi): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/capabilities') {
    reply(res, workerCapabilities(api)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/models') {
    if (!api.agent.listModels) unsupported();
    const cwd = url.searchParams.get('cwd');
    if (cwd !== null && cwd !== '') required(cwd, 'workspace', 4096);
    const models = await api.exclusive(async () => {
      if (api.connectionExclusive) api.assertIdle();
      return api.agent.listModels!({ cwd: cwd || undefined });
    });
    reply(res, models); return true;
  }
  if (req.method === 'GET' && url.pathname === '/sessions') {
    if (!api.sessions) unsupported();
    const sessions = await api.exclusive(() => api.sessions!.list());
    reply(res, sessions); return true;
  }
  const match = /^\/sessions\/([^/]+)\/(history|rename|archive|fork|turn-stop)$/.exec(url.pathname);
  const legacyRename = url.pathname === '/session-name';
  const legacyStop = url.pathname === '/native-turn-stop';
  if (!match && !legacyRename && !legacyStop) return false;
  const action = legacyRename ? 'rename' : legacyStop ? 'turn-stop' : match![2]!;
  if (req.method !== (action === 'history' ? 'GET' : 'POST'))
    throw new WorkerApiError(405, 'Method not allowed', 'invalid-request');
  let nativeId: string;
  try { nativeId = match ? required(decodeURIComponent(match[1]!), 'session ID', 256) : ''; }
  catch { throw new WorkerApiError(400, 'Invalid session ID', 'invalid-request'); }
  const value = action === 'history' ? {} : await readWorkerBody(req, 16384);
  if (!match) nativeId = required(value.id, 'session ID', 256);
  const capabilities = workerCapabilities(api);
  if (action === 'history') {
    if (!capabilities.sessions.history) unsupported();
    const history = await api.exclusive(() => api.sessions!.history(nativeId));
    if (!history) throw new WorkerApiError(404, 'Session history not found', 'not-found');
    reply(res, history); return true;
  }
  if (action === 'turn-stop') {
    if (!capabilities.nativeTurnStop) unsupported();
    const turnId = required(value.turnId, 'turn ID', 256), cwd = required(value.cwd, 'workspace', 4096);
    const stopped = await api.exclusive(async () => {
      api.assertIdle(api.connectionExclusive ? undefined : nativeId);
      return api.agent.stopNativeTurn!(nativeId, turnId, cwd);
    });
    reply(res, { stopped }); return true;
  }
  if (action === 'rename') {
    if (!capabilities.sessions.rename) unsupported();
    const name = required(value.name, 'session name', 2048);
    const cwd = value.cwd === undefined ? undefined : required(value.cwd, 'workspace', 4096);
    if (!api.sessions?.rename && !cwd) throw new WorkerApiError(400, 'Workspace is required', 'invalid-request');
    await api.exclusive(async () => {
      api.assertIdle(api.connectionExclusive ? undefined : nativeId);
      if (api.sessions?.rename) await api.sessions.rename(nativeId, name, cwd);
      else await api.agent.renameSession!(nativeId, name, cwd!);
    });
    reply(res, { ok: true }); return true;
  }
  if (action === 'archive') {
    if (!capabilities.sessions.archive) unsupported();
    await api.exclusive(async () => { api.assertIdle(api.connectionExclusive ? undefined : nativeId); await api.sessions!.archive!(nativeId); });
    reply(res, { ok: true }); return true;
  }
  if (!capabilities.sessions.fork) unsupported();
  const fork = await api.exclusive(async () => { api.assertIdle(api.connectionExclusive ? undefined : nativeId); return api.sessions!.fork!(nativeId); });
  reply(res, fork); return true;
}
