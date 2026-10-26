import { log, type LogFields } from './logger';

const REPEAT_WARNING_MS = 10 * 60_000;

/** Pollers back off while their source is unreachable and warn once per distinct error. */
export class PollHealth {
  private failures = 0;
  private retryAt = 0;
  private warned?: string;
  private warnedAt = 0;
  constructor(private readonly phase: string, private readonly event: string, private readonly fields: LogFields = {},
    private readonly baseMs = 1000, private readonly maxMs = 60_000, private readonly now: () => number = Date.now) {}
  /** Timer ticks skip until the backoff expires; explicit refreshes are never delayed. */
  due(): boolean { return this.now() >= this.retryAt; }
  warn(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error), at = this.now();
    if (message === this.warned && at - this.warnedAt < REPEAT_WARNING_MS) return;
    this.warned = message; this.warnedAt = at;
    log.warn(this.phase, this.event, { ...this.fields, error: message });
  }
  backoff(): void {
    this.failures++;
    this.retryAt = this.now() + Math.min(this.baseMs * 2 ** this.failures, this.maxMs);
  }
  failed(error: unknown): void { this.backoff(); this.warn(error); }
  ok(): void {
    this.failures = 0; this.retryAt = 0;
    if (this.warned === undefined) return;
    this.warned = undefined;
    log.info(this.phase, `${this.event}-recovered`, this.fields);
  }
}
