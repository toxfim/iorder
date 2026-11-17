import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { formatSecondsLeft, useCountdown } from './use-countdown';

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks down to zero and stops', () => {
    const scope = effectScope();
    const countdown = scope.run(() => useCountdown(() => '2026-10-30T10:00:03.000Z'));
    expect(countdown?.secondsLeft.value).toBe(3);
    vi.advanceTimersByTime(2000);
    expect(countdown?.secondsLeft.value).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(countdown?.secondsLeft.value).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it('is zero without an end, or with one already past', () => {
    const scope = effectScope();
    const none = scope.run(() => useCountdown(() => null));
    const past = scope.run(() => useCountdown(() => '2026-10-30T09:59:00.000Z'));
    expect(none?.secondsLeft.value).toBe(0);
    expect(past?.secondsLeft.value).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it('follows a new end and leaves no timer behind when the scope ends', async () => {
    const until = ref<string | null>(null);
    const scope = effectScope();
    const countdown = scope.run(() => useCountdown(until));
    until.value = '2026-10-30T10:01:00.000Z';
    await nextTick();
    expect(countdown?.secondsLeft.value).toBe(60);
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats minutes and seconds', () => {
    expect(formatSecondsLeft(125)).toBe('2:05');
    expect(formatSecondsLeft(59)).toBe('0:59');
  });
});
