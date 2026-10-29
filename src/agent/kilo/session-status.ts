import type { KiloClient } from './client';

export const KILO_BUSY_POLL_MS = 1_000;
export const KILO_BUSY_WAIT_MS = 30 * 60_000;
/** An unfinished turn that has not moved for this long cannot still be running (a client
 *  that vanished mid-turn leaves exactly that shape behind). */
export const KILO_BUSY_STALE_MS = 10 * 60_000;

/**
 * Kilo keeps `/session/status` in the memory of one server process, so an entry can
 * outlive the turn that produced it: an aborted turn, a provider retry that gave up,
 * or a client that vanished all leave `busy`/`retry` behind. Native messages are the
 * authoritative evidence, so only an unfinished newest turn counts as running.
 */
export function kiloStatusRunning(rows: any[] | undefined, status: any): boolean {
  if (!status || status.type === 'idle') return false;
  const last = Array.isArray(rows) ? rows.at(-1)?.info : undefined;
  if (!last) return false;
  return last.role === 'user' || !last.time?.completed;
}

async function sessionRunning(client: KiloClient, id: string, cwd?: string): Promise<boolean> {
  const statuses = await client.request<Record<string, any>>('GET', '/session/status', undefined, cwd);
  const status = statuses?.[id];
  if (!status || status.type === 'idle') return false;
  const rows = await client.request<any[]>('GET', `/session/${id}/message`, undefined, cwd);
  if (!kiloStatusRunning(rows, status)) return false;
  const last = rows.at(-1);
  const touched = Math.max(last?.info?.time?.updated ?? 0, last?.info?.time?.created ?? 0,
    ...(last?.parts ?? []).map((part: any) => part?.time?.end ?? part?.time?.start ?? 0));
  return !touched || Date.now() - touched <= KILO_BUSY_STALE_MS;
}

/**
 * Queues a new input behind a turn another entry is still running instead of failing.
 * Returns once the session looks idle, the caller cancels, or the wait budget runs out
 * (Kilo itself then orders the message behind whatever is still in flight).
 */
export async function waitForKiloSessionIdle(client: KiloClient, id: string, cwd: string | undefined,
  cancelled: () => boolean, waitMs = KILO_BUSY_WAIT_MS, pollMs = KILO_BUSY_POLL_MS): Promise<void> {
  let running: boolean;
  // A status probe must never fail the run; it only decides whether to wait first.
  try { running = await sessionRunning(client, id, cwd); } catch { return; }
  const deadline = Date.now() + waitMs;
  while (running && !cancelled() && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    try { running = await sessionRunning(client, id, cwd); } catch { return; }
  }
}
