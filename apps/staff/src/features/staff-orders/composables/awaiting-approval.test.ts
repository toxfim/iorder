import type { StaffDashboardSummary } from '@iorder/shared/staff-orders';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';
import type { ViewState } from '@core/composables/use-async-view';
import { createAwaitingApproval } from './awaiting-approval';

const NOW = new Date('2026-10-19T10:00:00.000Z');

const summary = (count: number, age: number): StaffDashboardSummary => ({
  generatedAt: NOW.toISOString(),
  businessDate: '2026-10-19',
  ordersByStatus: {},
  queues: [{ key: 'AWAITING_MANAGER', count, oldestWaitingSince: null, oldestAgeMinutes: age }],
});

function setup(
  state: ViewState,
  listed: { submittedAt: string }[],
  s: StaffDashboardSummary | null,
) {
  const stateRef = ref<ViewState>(state);
  const pending = shallowRef(listed);
  const summaryRef = shallowRef(s);
  const truncated = ref(false);
  const load = vi.fn(() => Promise.resolve());
  const approval = createAwaitingApproval(
    // The composable reads only these refs; the cast keeps the test free of a full store.
    { state: stateRef, pending, truncated, load } as never,
    { summary: summaryRef },
    { now: () => NOW },
  );
  return { approval, stateRef, pending, summaryRef, truncated, load };
}

describe('awaiting approval', () => {
  it('uses the summary queue while the list is not loaded yet (never a 0)', () => {
    const { approval, stateRef } = setup('loading', [], summary(2, 45));
    expect(approval.count.value).toBe(2);
    expect(approval.oldestAgeMinutes.value).toBe(45);
    stateRef.value = 'error';
    expect(approval.count.value).toBe(2);
  });

  it('is unknown (null) when neither the list nor the summary answered', () => {
    const { approval } = setup('error', [], null);
    expect(approval.count.value).toBeNull();
    expect(approval.oldestAgeMinutes.value).toBeNull();
  });

  it('shows the list count and age when the summary call failed', () => {
    const { approval } = setup('ready', [{ submittedAt: '2026-10-19T09:30:00.000Z' }], null);
    expect(approval.count.value).toBe(1);
    expect(approval.oldestAgeMinutes.value).toBe(30);
  });

  it('a loaded empty list is a real 0 with no age', () => {
    const { approval } = setup('empty', [], summary(2, 45));
    expect(approval.count.value).toBe(0);
    expect(approval.oldestAgeMinutes.value).toBeNull();
  });

  // The list is read once when the staff area opens; the summary is re-read every minute.
  describe('an order placed after the list was read', () => {
    it('reads the list again when a newer summary counts more than the loaded list', async () => {
      const { approval, summaryRef, pending, load } = setup('empty', [], summary(0, 0));
      expect(approval.count.value).toBe(0);

      summaryRef.value = summary(1, 2);
      await nextTick();
      expect(load).toHaveBeenCalledExactlyOnceWith({ silent: true });

      // The silent read answered: the card, the badge and the filter now show the order.
      pending.value = [{ submittedAt: '2026-10-19T09:58:00.000Z' }];
      expect(approval.count.value).toBe(1);
      expect(approval.oldestAgeMinutes.value).toBe(2);
    });

    it('also when the summary counts fewer (someone else approved it)', async () => {
      const { summaryRef, load } = setup(
        'ready',
        [{ submittedAt: '2026-10-19T09:30:00.000Z' }],
        summary(1, 30),
      );
      summaryRef.value = summary(0, 0);
      await nextTick();
      expect(load).toHaveBeenCalledExactlyOnceWith({ silent: true });
    });

    it('leaves the list alone while the summary agrees with it', async () => {
      const { summaryRef, load } = setup(
        'ready',
        [{ submittedAt: '2026-10-19T09:30:00.000Z' }],
        summary(1, 30),
      );
      summaryRef.value = summary(1, 31);
      await nextTick();
      expect(load).not.toHaveBeenCalled();
    });

    it('does not start a read for a list that is loading, failed or cut at the page cap', async () => {
      const { summaryRef, stateRef, truncated, load } = setup('loading', [], summary(0, 0));
      summaryRef.value = summary(1, 1);
      await nextTick();
      stateRef.value = 'error';
      summaryRef.value = summary(2, 1);
      await nextTick();
      // A cut list is a lower bound by design: the summary's larger number is shown instead.
      stateRef.value = 'ready';
      truncated.value = true;
      summaryRef.value = summary(3, 1);
      await nextTick();
      expect(load).not.toHaveBeenCalled();
    });

    // Found in review: if the two never agree (they are counted differently for some reason),
    // every summary answer started another read, one a minute for as long as the page was open.
    it('does not keep re-reading a list that came back with the same disagreement', async () => {
      const { summaryRef, pending, load } = setup('empty', [], summary(0, 0));
      summaryRef.value = summary(2, 5);
      await nextTick();
      expect(load).toHaveBeenCalledTimes(1);
      // The read answered and still holds no order; the next summaries say 2 again.
      summaryRef.value = summary(2, 6);
      await nextTick();
      summaryRef.value = summary(2, 7);
      await nextTick();
      expect(load).toHaveBeenCalledTimes(1);

      // A different disagreement is new information and is read once more.
      summaryRef.value = summary(3, 8);
      await nextTick();
      expect(load).toHaveBeenCalledTimes(2);

      // Once they agree the memory is cleared: the same numbers later are read again.
      pending.value = [
        { submittedAt: '2026-10-19T09:30:00.000Z' },
        { submittedAt: '2026-10-19T09:31:00.000Z' },
        { submittedAt: '2026-10-19T09:32:00.000Z' },
      ];
      summaryRef.value = summary(3, 9);
      await nextTick();
      pending.value = [];
      summaryRef.value = summary(3, 10);
      await nextTick();
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('does nothing when the summary is forgotten (another person signs in)', async () => {
      const { summaryRef, load } = setup('empty', [], summary(1, 1));
      summaryRef.value = null;
      await nextTick();
      expect(load).not.toHaveBeenCalled();
    });
  });
});
