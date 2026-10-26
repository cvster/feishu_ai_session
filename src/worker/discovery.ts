import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { probeWorker, WorkerClient, validWorkerHealth } from './client';
import type { WorkerHealth } from './protocol';
import { DurableAgentAdapter } from './adapter';
import { registerToolDefinition } from '../tools/definitions';
import type { AgentTool } from '../tools/types';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

export interface DiscoveredWorker { directory: string; health: WorkerHealth }
/** Only immediate worker directories are inspected; endpoint contents never choose an external host. */
export async function discoverWorkers(profileDir: string, botAppId: string, duplicates = new Set<string>()): Promise<DiscoveredWorker[]> {
  const root = join(profileDir, 'workers');
  const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const candidates = await Promise.all(entries.filter(e => e.isDirectory()).map(async entry => {
    const directory = join(root, entry.name);
    try { return { directory, health: await probeWorker(directory, botAppId) }; }
    catch { return undefined; }
  }));
  const counts = new Map<string, number>();
  for (const item of candidates) if (item) counts.set(item.health.toolId, (counts.get(item.health.toolId) ?? 0) + 1);
  return candidates.filter((item): item is DiscoveredWorker => {
    if (!item) return false;
    if (counts.get(item.health.toolId) !== 1) { duplicates.add(item.health.toolId); log.warn('worker', 'duplicate-discovery', { toolId: item.health.toolId }); return false; }
    return true;
  });
}

export function workerTool(worker: DiscoveredWorker): AgentTool {
  const { health, directory } = worker, manifest = health.manifest!, capabilities = health.capabilities!;
  registerToolDefinition(health.toolId, { label: manifest.label, backend: 'worker', nativeField: manifest.nativeField,
    fork: capabilities.sessions.fork, reasoning: true, sessionKind: manifest.sessionKind,
    promptInjection: 'none', nativeHistory: manifest.nativeHistory, legacyMarkers: [] });
  const client = new WorkerClient(directory, health.sourceId, health.botAppId, health.toolId, manifest);
  const agent = new DurableAgentAdapter(client, { displayName: manifest.label });
  return { id: health.toolId, sourceId: health.sourceId, label: manifest.label, agent,
    listSessions: () => client.listSessions(),
    sessions: { nativeArchive: capabilities.sessions.archive, historyMode: manifest.historyFormat === 'json' ? 'snapshot' : 'file',
      async historyPath(id) {
        const history = await client.sessionHistory(id);
        if (history.nativeId !== id || !['json', 'jsonl'].includes(history.format) || typeof history.content !== 'string' || Buffer.byteLength(history.content) > 32 * 1024 * 1024)
          throw new Error('Invalid worker history');
        const { createHash } = await import('node:crypto');
        const path = join(directory, 'bridge-history', `${createHash('sha256').update(id).digest('hex')}.${history.format}`);
        await writeFileAtomic(path, history.content, { mode: 0o600 }); return path;
      },
      rename: (id, name) => client.renameSession(id, name),
      archive: async id => { if (capabilities.sessions.archive) await client.archiveSession(id); },
      ...(capabilities.sessions.fork ? { fork: (id: string) => client.forkSession(id) } : {}),
    } };
}

/** Remember identities when offline; a disappearing endpoint never deletes a group binding. */
export async function loadWorkerRegistry(profileDir: string, botAppId: string): Promise<DiscoveredWorker[]> {
  const root = join(profileDir, 'workers');
  const file = join(root, 'registry.json');
  let cached: DiscoveredWorker[] = [], saved = '';
  try {
    saved = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(saved);
    if (Array.isArray(parsed)) cached = parsed.filter((w): w is DiscoveredWorker => {
      const item = w as DiscoveredWorker, suffix = typeof item?.directory === 'string' ? relative(root, item.directory) : '..';
      return validWorkerHealth(item?.health, botAppId) &&
        !!suffix && !isAbsolute(suffix) && !suffix.startsWith('..') && !suffix.includes('/') && !suffix.includes('\\');
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  cached = (await Promise.all(cached.map(async item => {
    const entry = await lstat(item.directory).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    return entry && !entry.isDirectory() ? undefined : item;
  }))).filter((item): item is DiscoveredWorker => !!item);
  const duplicates = new Set<string>();
  const live = await discoverWorkers(profileDir, botAppId, duplicates), result = new Map(cached.map(w => [w.health.toolId, w]));
  const ambiguous = new Set(cached.filter(w => cached.filter(other => other.health.toolId === w.health.toolId).length > 1).map(w => w.health.toolId));
  for (const id of [...duplicates, ...ambiguous]) result.delete(id);
  for (const item of live) {
    const previous = result.get(item.health.toolId);
    if (previous && (previous.health.sourceId !== item.health.sourceId || previous.directory !== item.directory ||
      previous.health.manifest!.nativeField !== item.health.manifest!.nativeField || previous.health.manifest!.sessionKind !== item.health.manifest!.sessionKind)) {
      log.warn('worker', 'identity-change-rejected', { toolId: item.health.toolId }); continue;
    }
    result.set(item.health.toolId, item);
  }
  const values = [...result.values()], text = JSON.stringify(values);
  if (text !== saved) await writeFileAtomic(file, text, { mode: 0o600 });
  return values;
}
