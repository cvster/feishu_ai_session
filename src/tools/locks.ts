/** Shared by all tool executors, separate from per-chat admission. */
export class NativeSessionLocks {
  private readonly held = new Set<string>();
  acquire(key: string): (() => void) | undefined {
    if (this.held.has(key)) return undefined;
    this.held.add(key);
    return () => { this.held.delete(key); };
  }
}
