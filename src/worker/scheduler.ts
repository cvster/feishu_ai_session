import type { WorkerJob } from './protocol';
import type { JobStore } from './store';

export function jobKeys(job: WorkerJob): string[] {
  const native =
    job.queue?.nativeId ??
    job.options.threadId ??
    job.options.sessionId ??
    job.options.initialSessionId;
  return [
    ...(native ? ['native:' + native] : []),
    ...(job.options.delivery?.scope ? ['scope:' + job.options.delivery.scope] : []),
    ...(!native && !job.options.delivery?.scope ? ['unbound'] : []),
  ];
}
/** One durable scheduler per worker. No provider/channel behavior lives here. */
export class PersistentScheduler {
  private pumping?: Promise<void>;
  private paused = false;
  private again = false;
  constructor(
    private deps: {
      store: JobStore;
      active: Map<string, Promise<void>>;
      limit: number;
      exclusive<T>(fn: () => Promise<T>): Promise<T>;
      execute(job: WorkerJob): Promise<void>;
      blocked?(job: WorkerJob): boolean;
      onError(error: unknown): void;
    },
  ) {}
  pause() {
    this.paused = true;
  }
  kick(): void {
    if (this.paused) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = this.deps
      .exclusive(async () => {
        while (!this.paused && this.deps.active.size < this.deps.limit) {
          const jobs = this.deps.store.list();
          const locked = new Set(
            jobs
              .filter((j) => this.deps.active.has(j.id) || j.queue?.recoveryPending)
              .flatMap(jobKeys),
          );
          const next = jobs
            .filter(
              (j) =>
                j.status === 'accepted' && !j.queue?.dispatchedAt && !this.deps.active.has(j.id),
            )
            .sort(
              (a, b) =>
                (a.queue?.sequence ?? a.createdAt) - (b.queue?.sequence ?? b.createdAt) ||
                a.id.localeCompare(b.id),
            )
            .find((j) => !jobKeys(j).some((k) => locked.has(k)) && !this.deps.blocked?.(j));
          if (!next) break;
          const dispatched = {
            ...next,
            queue: {
              version: 1 as const,
              sequence: next.queue?.sequence ?? next.createdAt,
              dispatchedAt: Date.now(),
            },
          };
          // Persist the uncertain boundary BEFORE any adapter/preflight/spawn.
          await this.deps.store.put(dispatched);
          const task = Promise.resolve()
            .then(() => this.deps.execute(dispatched))
            .catch((error) => {
              this.paused = true;
              this.deps.onError(error);
            })
            .finally(() => {
              this.deps.active.delete(next.id);
              this.kick();
            });
          this.deps.active.set(next.id, task);
          void task.catch((e) => this.deps.onError(e));
        }
      })
      .catch((e) => {
        this.paused = true;
        this.deps.onError(e);
      })
      .finally(() => {
        this.pumping = undefined;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }
  async idle(): Promise<void> {
    await this.pumping;
  }
}
