import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ProfileConfig } from '../config/profile-schema';
import { loadWorkerConfig } from './config';
import { messageRequestId } from './identity';

/** Compatibility import only. Never launch a native tool, send an input, or overwrite canonical worker configuration. */
export async function migrateWorkerConfiguration(profileDir: string, profile: ProfileConfig): Promise<ProfileConfig> {
  const raw = profile as unknown as Record<string, unknown>;
  const ids = ['codex', 'claude', 'kilo', 'zcode', 'dsh', 'pi'].filter(id => raw[id] || id === profile.agentKind);
  const migrated = ids.some(id => raw[id]);
  if (!migrated) return profile;
  for (const id of ids) await loadWorkerConfig(profileDir, id, profile);
  // Keep an immutable compatibility backup alongside the worker data.
  const backup = join(profileDir, 'workers', 'legacy-profile.json');
  if (!await stat(backup).catch(error => { if (error.code === 'ENOENT') return; throw error; }))
    await writeFileAtomic(backup, JSON.stringify(profile), { mode: 0o600 });
  const next = { ...profile };
  for (const id of ['codex', 'claude', 'kilo', 'zcode', 'dsh', 'pi']) delete (next as unknown as Record<string, unknown>)[id];
  return next;
}

/** Import receipt identities; accepted/uncertain old writes can never be submitted again. Idempotent across crashes.
 * Runs once: the inbox later expires settled receipts, and re-importing would revive a legacy pending record. */
export async function migrateLegacyIntake(profileDir: string): Promise<void> {
  const marker = join(profileDir, 'codex-inbox.legacy-imported');
  if (await stat(marker).catch(error => { if (error.code === 'ENOENT') return; throw error; })) return;
  let old;
  try { old = JSON.parse(await readFile(join(profileDir, 'codex-submissions.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (old.version !== 1 || !Array.isArray(old.records)) throw new Error('Invalid legacy intake ledger');
  const file = join(profileDir, 'codex-inbox.json');
  let inbox = { version: 1, entries: {} as Record<string, unknown> };
  try { inbox = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (inbox.version !== 1 || !inbox.entries || Array.isArray(inbox.entries)) throw new Error('Invalid canonical inbox');
  for (const record of old.records) {
    if (typeof record.scope !== 'string' || !Array.isArray(record.messages)) throw new Error('Invalid legacy receipt');
    for (const message of record.messages) {
      if (typeof message.messageId !== 'string') throw new Error('Invalid legacy message');
      const key = JSON.stringify([record.scope, messageRequestId(message)]);
      inbox.entries[key] ??= { scope: record.scope, message,
        status: record.status === 'pending' ? 'pending' : ['rejected', 'cancelled'].includes(record.status) ? 'rejected' : 'accepted' };
    }
  }
  await writeFileAtomic(file, JSON.stringify(inbox), { mode: 0o600 });
  await writeFileAtomic(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
}
