import { join, dirname, basename } from 'node:path';
import { readFile, copyFile, mkdir, chmod } from 'node:fs/promises';
import { SessionCatalog } from '../src/session/catalog';
import { ToolBindingStore } from '../src/tools/bindings';
import { SessionStore } from '../src/session/store';
import { WorkspaceStore } from '../src/workspace/store';
import { WorkerInbox } from '../src/worker/inbox';
import { writeFileAtomic } from '../src/platform/atomic-write';
import { workerInboxName } from '../src/tools/definitions';

// Maintenance entry point. Stop only the bridge writer before running; workers
// and native tools keep running. No native archive/delete or Feishu API calls.
const [profileDir, ...unlinkChats] = process.argv.slice(2);
if (!profileDir || unlinkChats.some(scope => !/^oc_[A-Za-z0-9]+$/.test(scope))) throw new Error('Usage: migrate-session-catalog <profile-dir> [chat-id ...]');
const files = ['sessions.json.catalog.json', 'sessions.json.catalog.json.archives.json', 'tool-bindings.json', 'sessions.json', 'workspaces.json'];
const backup = join(profileDir, 'config-backups', `catalog-v2-${Date.now()}`);
await mkdir(backup, { recursive: true, mode: 0o700 });
for (const name of files) try { await copyFile(join(profileDir, name), join(backup, name)); await chmod(join(backup, name), 0o600); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')); await catalog.load();
const bindings = new ToolBindingStore(join(profileDir, 'tool-bindings.json')); await bindings.load();
const sessions = new SessionStore(join(profileDir, 'sessions.json')); await sessions.load();
const workspaces = new WorkspaceStore(join(profileDir, 'workspaces.json')); await workspaces.load();
for (const chatId of unlinkChats) {
  const binding = bindings.get(chatId);
  const scopes = new Set([chatId, ...bindings.entries().map(([s]) => s), ...sessions.scopeIds(), ...Object.keys(workspaces.listCwds())]
    .filter(scope => scope === chatId || scope.startsWith(`${chatId}:`)));
  const rows = catalog.entries().filter(row => row.scopeId.split(':')[0] === chatId);
  const tools = new Set([...rows.map(row => row.agentId), ...bindings.entries().filter(([scope]) => scopes.has(scope)).map(([, ref]) => ref.toolId)]);
  if (binding) tools.add(binding.toolId);
  const inboxes: WorkerInbox[] = [];
  for (const tool of tools) {
    const inboxFile = workerInboxName(tool), inbox = new WorkerInbox(join(profileDir, inboxFile));
    await inbox.load(); inboxes.push(inbox);
    try { await copyFile(join(profileDir, inboxFile), join(backup, inboxFile)); await chmod(join(backup, inboxFile), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const refs = rows.filter(row => row.sourceId && (row.threadId ?? row.sessionId))
    .map(row => ({ agentId: row.agentId, sourceId: row.sourceId!, nativeId: (row.threadId ?? row.sessionId)! }));
  if (binding?.nativeId) refs.push({ agentId: binding.toolId, sourceId: binding.sourceId, nativeId: binding.nativeId });
  catalog.unlinkChat(chatId, refs);
  await catalog.flush(); // Write the tombstone before deleting the routing stores.
  for (const scope of scopes) { sessions.remove(scope); workspaces.removeCwd(scope); }
  for (const inbox of inboxes) await inbox.rejectChat(chatId);
  bindings.removeChat(chatId);
  for (const tool of tools) {
    const nameFile = join(profileDir, `${tool}-name-sync.json`);
    try {
      const ledger = JSON.parse(await readFile(nameFile, 'utf8'));
      await copyFile(nameFile, join(backup, `${tool}-name-sync.json`));
      ledger.bindings = ledger.bindings.filter(([key]: [string, unknown]) => !JSON.parse(key).includes(chatId));
      await writeFileAtomic(nameFile, JSON.stringify(ledger) + '\n', { mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const inbox of inboxes) await inbox.flush();
}
const configFile = join(dirname(dirname(profileDir)), 'config.json');
try {
  const root = JSON.parse(await readFile(configFile, 'utf8')), profile = root.profiles?.[basename(profileDir)];
  if (profile?.access?.allowedChats?.some((chat: string) => unlinkChats.includes(chat))) {
    await copyFile(configFile, join(backup, 'root-config.json'));
    profile.access.allowedChats = profile.access.allowedChats.filter((chat: string) => !unlinkChats.includes(chat));
    await writeFileAtomic(configFile, JSON.stringify(root, null, 2) + '\n', { mode: 0o600 });
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await Promise.all([catalog.flush(), bindings.flush(), sessions.flush(), workspaces.flush()]);
console.log(JSON.stringify({ profileDir, backup, schemaVersion: 2, activeRoutes: catalog.entries().filter(row => row.status === 'active').length,
  historyRows: catalog.entries().filter(row => row.status === 'archived').length, unlinkedChats: unlinkChats }));
