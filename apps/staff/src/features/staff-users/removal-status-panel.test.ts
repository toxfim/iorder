import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { GroupRemovalItem } from '@iorder/shared/staff-orders';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import { fakeUuid } from '@core/lib/fake-ids';
import { createTestServices } from '@/test-utils/create-test-services';
import type { StaffUsersApi } from './api/staff-users-api';
import RemovalStatusPanel from './components/RemovalStatusPanel.vue';

const wrappers: VueWrapper[] = [];
const USER = fakeUuid('u-101');
const GROUP_A = fakeUuid('g-a');
const GROUP_B = fakeUuid('g-b');

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

function row(
  organizationId: string,
  name: string,
  status: GroupRemovalItem['status'],
  errorCode: GroupRemovalItem['errorCode'],
  minute: number,
): GroupRemovalItem {
  const at = `2026-10-19T04:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    organizationId,
    organizationName: name,
    status,
    errorCode,
    maybeBanned: false,
    requestedAt: at,
    completedAt: status === 'PENDING' ? null : at,
  };
}

async function mountPanel(items: GroupRemovalItem[], blocked = true) {
  const { services: base } = createTestServices({ identityId: 'manager' });
  await base.currentUser.ensureLoaded();
  const services: Services = {
    ...base,
    staffUsersApi: {
      ...base.staffUsersApi,
      removalStatus: vi.fn<StaffUsersApi['removalStatus']>(async () => items),
    },
  };
  const wrapper = mount(RemovalStatusPanel, {
    attachTo: document.body,
    props: { userId: USER, blocked },
    global: { provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

const rows = (): string[] =>
  Array.from(document.body.querySelectorAll('.item')).map((e) =>
    (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
const retry = (): Element | null => document.body.querySelector('[data-testid="removal-retry"]');

describe('removal status panel: one row per group (the server lists every attempt, newest first)', () => {
  it('FAILED then PENDING for the same group shows only the pending attempt and no retry', async () => {
    await mountPanel([
      row(GROUP_A, 'Group A', 'PENDING', null, 10),
      row(GROUP_A, 'Group A', 'FAILED', 'BOT_NOT_ADMIN', 5),
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Kutilmoqda');
    expect(rows()[0]).not.toContain('Bot bu guruhda administrator emas');
    expect(retry()).toBeNull();
  });

  it('FAILED then DONE shows done, without a failure reason and without a retry button', async () => {
    await mountPanel([
      row(GROUP_A, 'Group A', 'DONE', null, 10),
      row(GROUP_A, 'Group A', 'FAILED', 'BOT_NOT_ADMIN', 5),
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Chiqarildi');
    expect(rows()[0]).not.toContain('Bot bu guruhda administrator emas');
    expect(retry()).toBeNull();
  });

  it('keeps the newest row of each of two groups and retries on the newest failure only', async () => {
    await mountPanel([
      row(GROUP_B, 'Group B', 'FAILED', 'BOT_NOT_ADMIN', 12),
      row(GROUP_A, 'Group A', 'DONE', null, 10),
      row(GROUP_A, 'Group A', 'FAILED', 'BOT_NOT_ADMIN', 5),
    ]);
    expect(rows()).toHaveLength(2);
    expect(rows().join('|')).toContain('Group B');
    expect(retry()).not.toBeNull();
  });
});

describe('removal status panel: retry only for a blocked person', () => {
  const failed = [row(GROUP_A, 'Group A', 'FAILED', 'BOT_NOT_ADMIN', 5)];

  it('offers the retry when the person is blocked', async () => {
    await mountPanel(failed, true);
    expect(retry()).not.toBeNull();
  });

  it('offers no retry once the person is unblocked, though the failure stays listed', async () => {
    await mountPanel(failed, false);
    expect(rows()).toHaveLength(1);
    expect(retry()).toBeNull();
  });
});
