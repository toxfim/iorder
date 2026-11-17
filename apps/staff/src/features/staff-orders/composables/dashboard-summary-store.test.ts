import type { StaffDashboardSummary } from '@iorder/shared/staff-orders';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PermissionDeniedError, UnauthenticatedError } from '@core/lib/api-errors';
import type { DashboardSummaryApi } from '../api/dashboard-summary-api';
import {
  SUMMARY_MAX_BACKOFF_MS,
  SUMMARY_REFRESH_MS,
  createDashboardSummaryStore,
} from './dashboard-summary-store';

const summary = (queueCount: number): StaffDashboardSummary => ({
  generatedAt: '2026-10-19T04:30:00.000Z',
  businessDate: '2026-10-19',
  ordersByStatus: {},
  queues: [
    {
      key: 'TO_RELEASE',
      count: queueCount,
      oldestWaitingSince: null,
      oldestAgeMinutes: null,
    },
  ],
});

function setup() {
  const getSummary = vi.fn<DashboardSummaryApi['getSummary']>();
  const store = createDashboardSummaryStore({ getSummary });
  return { getSummary, store };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dashboard summary store: states', () => {
  it('is loading until the first answer, then ready', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(2));
    expect(store.state.value).toBe('loading');
    await store.refresh();
    expect(store.state.value).toBe('ready');
    expect(store.summary.value?.queues[0]?.count).toBe(2);
    expect(store.stale.value).toBe(false);
  });

  it('is an error when the first read fails, and recovers on retry', async () => {
    const { getSummary, store } = setup();
    getSummary.mockRejectedValueOnce(new ApiError('down')).mockResolvedValueOnce(summary(1));
    await store.refresh();
    expect(store.state.value).toBe('error');
    await store.refresh();
    expect(store.state.value).toBe('ready');
  });

  it('keeps the last good numbers when a later read fails and says they are stale', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValueOnce(summary(4)).mockRejectedValueOnce(new ApiError('down'));
    await store.refresh();
    await store.refresh();
    expect(store.state.value).toBe('ready');
    expect(store.stale.value).toBe(true);
    expect(store.summary.value?.queues[0]?.count).toBe(4);
  });

  it('is denied on a permission error and drops the numbers it held', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValueOnce(summary(4)).mockRejectedValueOnce(new PermissionDeniedError());
    await store.refresh();
    await store.refresh();
    expect(store.state.value).toBe('denied');
    expect(store.summary.value).toBeNull();
  });

  it('treats a 401 (expired session) like a denial: numbers dropped, polling stopped', async () => {
    // The http client turns 401 into UnauthenticatedError and does not sign the user out itself.
    const { getSummary, store } = setup();
    getSummary.mockResolvedValueOnce(summary(4)).mockRejectedValue(new UnauthenticatedError());
    const stop = store.startAutoRefresh();
    await store.refresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(store.state.value).toBe('denied');
    expect(store.summary.value).toBeNull();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 5);
    expect(getSummary).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reset forgets the numbers and the failure of the previous person', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValueOnce(summary(4)).mockRejectedValueOnce(new ApiError('down'));
    await store.refresh();
    store.reset();
    expect(store.summary.value).toBeNull();
    expect(store.state.value).toBe('loading');
    await store.refresh();
    expect(store.state.value).toBe('error'); // the old numbers do not come back as stale
    expect(store.summary.value).toBeNull();
  });

  it('reset discards a read that was still running for the previous person', async () => {
    const { getSummary, store } = setup();
    let finish: (value: StaffDashboardSummary) => void = () => undefined;
    getSummary.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const old = store.refresh();
    store.reset();
    finish(summary(9));
    await old;
    expect(store.summary.value).toBeNull();
    getSummary.mockResolvedValueOnce(summary(1));
    await store.refresh();
    expect(store.summary.value?.queues[0]?.count).toBe(1);
  });

  it('joins a read that is already running instead of sending a second request', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(getSummary).toHaveBeenCalledTimes(1);
  });

  it('refreshIfShown reads only while a panel has started the auto refresh', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    await store.refreshIfShown();
    expect(getSummary).not.toHaveBeenCalled();
    const stop = store.startAutoRefresh();
    await store.refreshIfShown();
    expect(getSummary).toHaveBeenCalledTimes(1);
    stop();
    stop(); // stopping twice must not unbalance the count
    await store.refreshIfShown();
    expect(getSummary).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard summary store: a change during a read', () => {
  it('reads again after the running read, so the older answer does not stay on screen', async () => {
    const { getSummary, store } = setup();
    let releaseFirst: (value: StaffDashboardSummary) => void = () => undefined;
    getSummary
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockResolvedValueOnce(summary(1));
    const stop = store.startAutoRefresh();
    const running = store.refresh();
    const afterChange = store.refreshIfShown(); // an approval was answered meanwhile
    releaseFirst(summary(2)); // the read that started before the change
    await Promise.all([running, afterChange]);
    expect(getSummary).toHaveBeenCalledTimes(2);
    expect(store.summary.value?.queues[0]?.count).toBe(1);
    stop();
  });
});

describe('dashboard summary store: automatic refresh', () => {
  it('reads again every minute and stops when asked', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    const stop = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 5);
    expect(getSummary).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden and catches up when it comes back', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    const stop = store.startAutoRefresh();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 10);
    expect(getSummary).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSummary).toHaveBeenCalledTimes(1); // older than a minute: read at once
    stop();
  });

  it('does not read at once on return when the numbers are still fresh', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    const stop = store.startAutoRefresh();
    await store.refresh();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSummary).toHaveBeenCalledTimes(1);
    stop();
  });

  it('waits longer after each failure, up to a ceiling, and goes back to normal after a success', async () => {
    const { getSummary, store } = setup();
    getSummary.mockRejectedValue(new ApiError('down'));
    const stop = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS); // 1st read fails
    expect(getSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS); // next wait is two minutes
    expect(getSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SUMMARY_MAX_BACKOFF_MS * 3);
    // Never more often than the ceiling allows: at most one read per ceiling after the ramp-up.
    expect(getSummary.mock.calls.length).toBeLessThanOrEqual(2 + 3 + 1);
    getSummary.mockResolvedValue(summary(1));
    await vi.advanceTimersByTimeAsync(SUMMARY_MAX_BACKOFF_MS);
    const callsAfterRecovery = getSummary.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary.mock.calls.length).toBe(callsAfterRecovery + 1);
    stop();
  });

  it('stops for good after a permission error', async () => {
    const { getSummary, store } = setup();
    getSummary.mockRejectedValue(new PermissionDeniedError());
    const stop = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_MAX_BACKOFF_MS * 3);
    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(store.state.value).toBe('denied');
    stop();
  });
});

describe('dashboard summary store: several subscribers', () => {
  it('share one timer, so a second start does not double the reads', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    const stopShell = store.startAutoRefresh();
    const stopPanel = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(2);
    stopPanel();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(3); // the shell is still subscribed
    stopShell();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 5);
    expect(getSummary).toHaveBeenCalledTimes(3);
  });

  it('a late subscriber after a full stop starts a fresh loop', async () => {
    const { getSummary, store } = setup();
    getSummary.mockResolvedValue(summary(1));
    store.startAutoRefresh()();
    const stop = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(getSummary).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reset restarts a loop that a permission error had stopped', async () => {
    const { getSummary, store } = setup();
    getSummary.mockRejectedValueOnce(new PermissionDeniedError()).mockResolvedValue(summary(3));
    const stop = store.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(store.state.value).toBe('denied');
    store.reset(); // another person signs in
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    expect(store.summary.value?.queues[0]?.count).toBe(3);
    stop();
  });
});
