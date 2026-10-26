import { afterEach, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger';
import { PollHealth } from '../../../src/core/poll-health';

afterEach(() => { vi.restoreAllMocks(); });

it('backs off exponentially while unreachable, warns once per distinct error and reports recovery', () => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {}), info = vi.spyOn(log, 'info').mockImplementation(() => {});
  let now = 0;
  const health = new PollHealth('replies', 'sync-unavailable', { toolId: 'kilo' }, 1000, 8000, () => now);
  const retryAfter = () => { let wait = 0; while (!health.due()) { now += 1000; wait += 1000; } return wait; };
  health.failed(new Error('ENOENT')); expect(retryAfter()).toBe(2000);
  health.failed(new Error('ENOENT')); expect(retryAfter()).toBe(4000);
  health.failed(new Error('ENOENT')); health.failed(new Error('ENOENT')); expect(retryAfter()).toBe(8000);
  expect(warn).toHaveBeenCalledOnce();
  health.failed(new Error('timeout')); expect(warn).toHaveBeenCalledTimes(2);
  health.ok(); expect(health.due()).toBe(true);
  expect(info).toHaveBeenCalledWith('replies', 'sync-unavailable-recovered', { toolId: 'kilo' });
  health.ok(); expect(info).toHaveBeenCalledOnce();
});
