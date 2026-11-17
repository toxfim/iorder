import { describe, expect, it } from 'vitest';
import { UpdateFailureTracker } from './update-failure-tracker.js';

describe('UpdateFailureTracker', () => {
  it('counts failures per update and forgets an update once it succeeds', () => {
    const tracker = new UpdateFailureTracker();
    expect(tracker.recordFailure(1)).toBe(1);
    expect(tracker.recordFailure(1)).toBe(2);
    expect(tracker.recordFailure(2)).toBe(1);
    tracker.clear(1);
    expect(tracker.recordFailure(1)).toBe(1);
  });

  it('stays bounded: the oldest updates are forgotten first', () => {
    const tracker = new UpdateFailureTracker();
    for (let id = 0; id < 5_000; id += 1) tracker.recordFailure(id);
    expect(tracker.size).toBeLessThanOrEqual(500);
    // The newest are still counted, the oldest started again from zero.
    expect(tracker.recordFailure(4_999)).toBe(2);
    expect(tracker.recordFailure(0)).toBe(1);
  });
});
