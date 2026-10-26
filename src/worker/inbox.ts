import { readFile } from 'node:fs/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { writeFileAtomic } from '../platform/atomic-write';
import { messageRequestId } from './identity';
import type { WorkerJob } from './protocol';

interface InboxEntry { scope: string; message: NormalizedMessage; status: 'pending' | 'accepted' | 'rejected' | 'cancelled'; notified?: boolean;
  diagnostic?: { at: number; code: string; message: string; retryable: boolean } }
/** Outlives worker job retention (14 days) so a redelivered message is never accepted twice. */
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Bridge-only writer; persists input before debounce and keeps receipt identities. */
export class WorkerInbox {
  private entries: Record<string, InboxEntry> = {};
  private queued = new Set<string>();
  private deferredUntil = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== 1 || !raw.entries || Array.isArray(raw.entries)) throw new Error('Invalid worker inbox');
      for (const value of Object.values(raw.entries) as InboxEntry[]) if (!value.message?.messageId || !value.scope || !['pending', 'accepted', 'rejected', 'cancelled'].includes(value.status)) throw new Error('Invalid worker inbox receipt');
      this.entries = raw.entries;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const cutoff = this.now() - RECEIPT_RETENTION_MS;
    let pruned = false;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.status !== 'pending' && Number(entry.message.createTime) < cutoff) { delete this.entries[key]; pruned = true; }
    }
    if (pruned) await this.persist();
  }
  private key(scope: string, message: NormalizedMessage) { return JSON.stringify([scope, messageRequestId(message)]); }
  async receive(scope: string, message: NormalizedMessage): Promise<boolean> {
    const key = this.key(scope, message);
    if (this.entries[key]) return false;
    this.entries[key] = { scope, message, status: 'pending' }; await this.persist(); return true;
  }
  markQueued(scope: string, message: NormalizedMessage): boolean {
    const key = this.key(scope, message);
    if (this.entries[key]?.status !== 'pending') return false;
    this.queued.add(key); return true;
  }
  async cancelPending(scope: string, requestId: string): Promise<boolean> {
    const key = JSON.stringify([scope, requestId]), entry = this.entries[key];
    if (!entry || entry.status !== 'pending') return false;
    entry.status = 'cancelled'; this.queued.delete(key); this.deferredUntil.delete(key);
    await this.persist(); return true;
  }
  releaseQueued(scope: string, messages: NormalizedMessage[]): void { for (const message of messages) this.queued.delete(this.key(scope, message)); }
  receipts(scope: string): InboxEntry[] { return structuredClone(Object.values(this.entries).filter(e => e.scope === scope)); }
  pendingReceipts(scope: string) {
    return Object.entries(this.entries).filter(([, entry]) => entry.scope === scope && entry.status === 'pending')
      .map(([key, entry]) => ({ ...structuredClone(entry), requestId: messageRequestId(entry.message), queued: this.queued.has(key) }));
  }
  diagnostics() { return Object.entries(this.entries).map(([key, entry]) => ({ ...structuredClone(entry), requestId: messageRequestId(entry.message), queued: this.queued.has(key), retryAt: this.deferredUntil.get(key) })); }
  async recordDiagnostic(scope: string, messages: NormalizedMessage[], code: string, message: string, retryable: boolean) {
    for (const msg of messages) {
      const entry = this.entries[this.key(scope, msg)];
      if (entry?.status === 'pending') entry.diagnostic = { at: Date.now(), code, message, retryable };
    }
    await this.persist();
  }
  retryPending(scope: string, requestId: string): boolean {
    const key = JSON.stringify([scope, requestId]), entry = this.entries[key];
    if (!entry || entry.status !== 'pending' || this.queued.has(key)) return false;
    this.deferredUntil.delete(key); return true;
  }
  async rememberSenderName(scope: string, messageId: string, name: string): Promise<void> {
    const entry = Object.values(this.entries).find(e => e.scope === scope && e.message.messageId === messageId);
    if (!entry || entry.message.senderName === name) return;
    entry.message.senderName = name; await this.persist();
  }
  available(): InboxEntry[] { return Object.entries(this.entries).filter(([key, entry]) => entry.status === 'pending' && !this.queued.has(key) && (this.deferredUntil.get(key) ?? 0) <= Date.now()).map(([, entry]) => entry); }
  defer(scope: string, messages: NormalizedMessage[]): void {
    for (const message of messages) this.deferredUntil.set(this.key(scope, message), Date.now() + 5000);
  }
  async notifyOnce(scope: string, messages: NormalizedMessage[]): Promise<boolean> {
    let first = false;
    for (const message of messages) {
      const entry = this.entries[this.key(scope, message)];
      if (entry && !entry.notified) { entry.notified = true; first = true; }
    }
    if (first) await this.persist(); return first;
  }
  async rejectScope(scope: string): Promise<void> {
    await this.reject(scope, Object.values(this.entries).filter(e => e.scope === scope && e.status === 'pending').map(e => e.message));
  }
  async rejectChat(chatId: string): Promise<void> {
    const scopes = new Set(Object.values(this.entries).filter(e => e.scope.split(':')[0] === chatId && e.status === 'pending').map(e => e.scope));
    for (const scope of scopes) await this.rejectScope(scope);
  }
  async reject(scope: string, messages: NormalizedMessage[]): Promise<void> {
    for (const message of messages) {
      const key = this.key(scope, message), entry = this.entries[key];
      if (entry?.status === 'pending') entry.status = 'rejected';
      this.queued.delete(key);
    }
    await this.persist();
  }
  async reconcile(jobs: WorkerJob[]): Promise<void> {
    const receipts = new Set(jobs.flatMap(job => (job.options.delivery?.messageIds ?? []).map(id => JSON.stringify([job.options.delivery!.scope, id]))));
    let changed = false;
    for (const [key, entry] of Object.entries(this.entries)) if (entry.status === 'pending' && receipts.has(key)) { entry.status = 'accepted'; changed = true; }
    if (changed) await this.persist();
  }
  private persist(): Promise<void> {
    const data = `${JSON.stringify({ version: 1, entries: this.entries })}\n`;
    this.saving = this.saving.then(() => writeFileAtomic(this.path, data, { mode: 0o600 }));
    void this.saving.catch(() => {}); return this.saving;
  }
  flush(): Promise<void> { return this.saving; }
}
