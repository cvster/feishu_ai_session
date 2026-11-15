import { ownerApiUnavailable } from './owner-cache';
export function feishuAvailabilityFailure(error: unknown, depth = 0): boolean {
  if (!error || depth > 5) return false;
  const e = error as { message?: string; code?: number; response?: { status?: number; data?: { code?: number } }; cause?: unknown };
  const status = e.response?.status;
  return e.code === 99991403 || e.response?.data?.code === 99991403 || status === 429 ||
    (typeof status === 'number' && status >= 500 && status < 600) || ownerApiUnavailable(e.message) || feishuAvailabilityFailure(e.cause, depth + 1);
}
export async function connectForLocalWeb(channel: { connect(): Promise<void> }, allowOffline: boolean): Promise<boolean> {
  try { await channel.connect(); return true; }
  catch (error) { if (!allowOffline || !feishuAvailabilityFailure(error)) throw error; return false; }
}
