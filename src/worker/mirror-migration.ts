import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionCatalog } from '../session/catalog';

/** Preserve message/card IDs and sequence owners from both previous native mirror ledger formats. */
export async function migrateMirrorLedger(oldPath: string, newPath: string, toolId: string, sourceId: string, catalog: SessionCatalog): Promise<void> {
  try { await readFile(newPath); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let raw;
  try { raw = JSON.parse(await readFile(oldPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (raw.version === 1 && raw.bindings) { await writeFileAtomic(newPath, JSON.stringify(raw), { mode: 0o600 }); return; }
  if (![1, 2].includes(raw.version) || !raw.threads || Array.isArray(raw.threads)) throw new Error('Invalid previous native mirror ledger');
  const bindings: Record<string, unknown> = {};
  for (const row of catalog.entries()) {
    const nativeId = row.threadId ?? row.sessionId;
    if (row.agentId !== toolId || !nativeId || (row.sourceId && row.sourceId !== sourceId)) continue;
    const old = raw.threads[nativeId]; if (!old) continue;
    const turns: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(old.turns) as [string, any][]) {
      const delivery = value.deliveries?.[row.scopeId];
      // Existing deliveries continue in place, including legacy bridge turns.
      // An absent receipt from the old writer is uncertain, never a reason to send again.
      turns[id] = { createdAtMs: value.discoveredAtMs, sequence: delivery?.sequence ?? 0,
        skipped: !delivery?.messageId || delivery.status === 'skipped',
        inputMessageId: value.userEchoed?.[row.scopeId] ? 'legacy-echo' : undefined,
        cardId: delivery?.cardId, messageId: delivery?.messageId,
        hash: delivery?.lastContentHash, pushedAt: delivery?.lastPushedAtMs,
        lastActivityAt: delivery?.lastActivityAtMs, legacyBridge: value.origin === 'bridge' };
    }
    bindings[JSON.stringify([row.scopeId, sourceId, nativeId])] = { baselineAtMs: Date.now(), boundAtMs: row.boundAt ?? row.updatedAt, turns };
  }
  await writeFileAtomic(newPath, JSON.stringify({ version: 1, bindings }), { mode: 0o600 });
}
