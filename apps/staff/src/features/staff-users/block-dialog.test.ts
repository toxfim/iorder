import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { BlockUserResponse, GroupRemovalItem } from '@iorder/shared/staff-orders';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiRateLimitedError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import { createTestServices } from '@/test-utils/create-test-services';
import type { StaffUsersApi } from './api/staff-users-api';
import BlockUserDialog from './components/BlockUserDialog.vue';

const wrappers: VueWrapper[] = [];
const MEMBER = fakeUuid('u-101');
const SMART_ZONE_OWNER = fakeUuid('u-151');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
});

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const q = <T extends Element>(selector: string): T | null =>
  document.body.querySelector<T>(selector);
const text = (selector: string): string => squash(q(selector)?.textContent);
const click = async (selector: string): Promise<void> => {
  (q<HTMLElement>(selector) as HTMLElement).click();
  await flushPromises();
};

async function open(
  options: {
    identity?: string;
    userId?: string;
    groups?: string[];
    api?: Partial<StaffUsersApi>;
    staffUsers?: Parameters<typeof createTestServices>[0] extends infer O
      ? O extends { staffUsers?: infer S }
        ? S
        : never
      : never;
  } = {},
) {
  const { services: base } = createTestServices({
    identityId: options.identity ?? 'manager',
    ...(options.staffUsers ? { staffUsers: options.staffUsers } : {}),
  });
  await base.currentUser.ensureLoaded();
  const services: Services = {
    ...base,
    staffUsersApi: { ...base.staffUsersApi, ...options.api },
  };
  const wrapper = mount(BlockUserDialog, {
    attachTo: document.body,
    props: {
      modelValue: true,
      userId: options.userId ?? MEMBER,
      name: 'Jasur Karimov',
      groups: options.groups ?? ['Orion Mobile'],
    },
    global: { provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, services };
}

/** What the fake api answers to a block, taken from a signed-in manager's own services. */
async function fakeAnswer(removeFromGroups = false): Promise<BlockUserResponse> {
  const { services } = createTestServices({ identityId: 'manager' });
  await services.currentUser.ensureLoaded();
  return services.staffUsersApi.blockUser(MEMBER, { removeFromGroups });
}

const radio = (value: string): HTMLInputElement =>
  q<HTMLInputElement>(`input[type="radio"][value="${value}"]`) as HTMLInputElement;

describe('block dialog: the question', () => {
  it('names the person and the groups, asks the question, and defaults to blocking only', async () => {
    await open({ groups: ['Orion Mobile', 'Click Store'] });
    expect(text('.modal__title')).toBe('Bloklash: Jasur Karimov');
    expect(
      Array.from(document.body.querySelectorAll('.groups__list li')).map((e) => e.textContent),
    ).toEqual(['Orion Mobile', 'Click Store']);
    expect(text('legend')).toBe('Guruhdan ham chiqarilsinmi?');
    expect(radio('only').checked).toBe(true);
    expect(radio('remove').checked).toBe(false);
    expect(text('[data-testid="block-confirm"]')).toBe('Bloklash');
    expect(text('.consequence')).toContain('guruh adminlari uni qayta taklif qila oladi');
    expect(text('.consequence')).toContain('Blokdan chiqarish odamni guruhga qaytarmaydi');
  });

  it('says so when the person is in no group', async () => {
    await open({ groups: [] });
    expect(text('.groups')).toContain("Hech qaysi Telegram guruhida a'zo emas");
  });

  it('changes the confirm label when removal is chosen', async () => {
    await open();
    radio('remove').click();
    await flushPromises();
    expect(text('[data-testid="block-confirm"]')).toBe('Bloklash va chiqarish');
  });

  it('is a labelled dialog with a fieldset legend for the two choices', async () => {
    await open();
    const dialog = q('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(q('fieldset legend')).not.toBeNull();
    expect(document.body.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  });
});

describe('block dialog: blocking only', () => {
  it('sends removeFromGroups=false, toasts, emits and closes', async () => {
    const answer = await fakeAnswer();
    const blockUser = vi.fn<StaffUsersApi['blockUser']>(async () => answer);
    const { wrapper } = await open({ api: { blockUser } });
    await click('[data-testid="block-confirm"]');
    expect(blockUser).toHaveBeenCalledWith(MEMBER, { removeFromGroups: false });
    expect(wrapper.emitted('blocked')).toEqual([[false]]);
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
    expect(useToast().toast.value?.message).toBe('Jasur Karimov bloklandi');
  });
});

describe('block dialog: blocking and removing', () => {
  it('sends removeFromGroups=true and then shows the removal status, PENDING until it settles', async () => {
    const { wrapper } = await open();
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    expect(wrapper.emitted('blocked')).toEqual([[true]]);
    expect(text('.modal__title')).toBe('Bloklandi: Jasur Karimov');
    expect(q('[data-testid="block-done"]')).not.toBeNull();
    expect(text('[data-testid="removal-status"]')).toContain('Orion Mobile');
    expect(text('[data-testid="removal-status"]')).toContain('Kutilmoqda');

    // The manual refresh reads again; the fake settles on the second read.
    await click('[data-testid="removal-refresh"]');
    expect(text('[data-testid="removal-status"]')).toContain('Chiqarildi');
    expect(q('[data-testid="removal-retry"]')).toBeNull();
  });

  it('refreshes by itself while something is PENDING and stops when settled', async () => {
    await open();
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    expect(text('[data-testid="removal-status"]')).toContain('Kutilmoqda');
    expect(text('[data-testid="removal-status"]')).toContain('o‘zi yangilanib turadi');
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(text('[data-testid="removal-status"]')).toContain('Chiqarildi');
    expect(text('[data-testid="removal-status"]')).not.toContain('o‘zi yangilanib turadi');
  });

  it('moves focus into the dialog when the question gives way to the removal status', async () => {
    await open();
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    expect(document.activeElement).toBe(q('[data-testid="block-done"]'));
  });

  it('explains a failure in plain words and retries only after the cause can be fixed', async () => {
    await open({ userId: SMART_ZONE_OWNER, groups: ['Smart Zone Namangan'] });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    await click('[data-testid="removal-refresh"]');
    const panel = text('[data-testid="removal-status"]');
    expect(panel).toContain('Bajarilmadi');
    expect(panel).toContain('Bot bu guruhda administrator emas');
    expect(panel).not.toContain('BOT_NOT_ADMIN');

    await click('[data-testid="removal-retry"]');
    expect(text('[data-testid="removal-status"]')).toContain('1 ta guruh qayta navbatga');
    await click('[data-testid="removal-refresh"]');
    await click('[data-testid="removal-refresh"]');
    expect(text('[data-testid="removal-status"]')).toContain('Chiqarildi');
  });

  it('warns that the person may still be banned and offers no retry for UNBAN_FAILED', async () => {
    await open({
      staffUsers: { pendingReads: 0, removalOutcome: () => 'UNBAN_FAILED' },
    });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    await click('[data-testid="removal-refresh"]');
    const panel = text('[data-testid="removal-status"]');
    expect(panel).toContain('blokdan chiqarib bo');
    expect(panel).toContain("hali bloklangan bo'lishi mumkin");
    expect(panel).toContain("qo'lda blokdan chiqarishi kerak");
    expect(q('[data-testid="removal-retry"]')).toBeNull();
  });

  it.each([
    ['NOT_A_MEMBER', "allaqachon yo'q"],
    ['CHAT_NOT_FOUND', 'Guruh topilmadi'],
    ['CANNOT_REMOVE_MEMBER', 'guruh egasi yoki boshqa administrator'],
    ['REMOVAL_REJECTED', "Telegram so'rovni rad etdi"],
    ['REMOVAL_NOT_ALLOWED', 'bosh tortdi'],
    ['CHAT_MIGRATED', 'superguruhga aylangan'],
    ['RATE_LIMITED_TOO_LONG', 'bir kun davomida'],
    ['RETRIES_EXHAUSTED', 'necha urinishdan keyin'],
  ] as const)('shows a plain reason for %s', async (code, fragment) => {
    await open({ staffUsers: { pendingReads: 0, removalOutcome: () => code } });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    await click('[data-testid="removal-refresh"]');
    const panel = text('[data-testid="removal-status"]');
    expect(panel).toContain(fragment);
    expect(panel).not.toContain(code);
  });

  it('tells the person when nothing was queued (no group)', async () => {
    const base = await fakeAnswer();
    const blockUser = vi.fn(async (): Promise<BlockUserResponse> => ({
      ...base,
      groupRemoval: { requested: true, queued: 0, alreadyRequested: 0 },
    }));
    await open({ api: { blockUser } });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    expect(text('[data-testid="block-done"]')).toContain('Chiqariladigan guruh topilmadi');
  });
});

describe('block dialog: busy state, double submit and failures', () => {
  it('sends one request for a double click, locks the buttons and cannot be dismissed meanwhile', async () => {
    let finish: (value: BlockUserResponse) => void = () => undefined;
    const pending = new Promise<BlockUserResponse>((resolve) => {
      finish = resolve;
    });
    const blockUser = vi.fn(() => pending);
    const { wrapper } = await open({ api: { blockUser } });
    const confirm = q<HTMLButtonElement>('[data-testid="block-confirm"]') as HTMLButtonElement;
    confirm.click();
    confirm.click();
    await flushPromises();
    expect(blockUser).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(radio('remove').closest('fieldset')?.disabled).toBe(true);

    // Escape and the overlay do not close it while the request runs.
    q<HTMLElement>('.modal__overlay')?.click();
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();

    finish(await fakeAnswer());
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
  });

  it.each([
    ['403', new PermissionDeniedError('x'), "Bu amalga ruxsat yo'q."],
    ['404', new ApiNotFoundError('x', 'NOT_FOUND'), 'Bunday odam topilmadi'],
    ['409', new ApiConflictError('x', 'CONFLICT'), "holat o'zgargan"],
    ['429', new ApiRateLimitedError('x', 'TOO_MANY_REQUESTS', 9), '9 soniyadan keyin'],
    ['network', new Error('boom'), "Amalni bajarib bo'lmadi. Keyinroq"],
  ])('stays open with a message for %s and allows another try', async (_name, failure, message) => {
    const blockUser = vi
      .fn<StaffUsersApi['blockUser']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(await fakeAnswer());
    const { wrapper } = await open({ api: { blockUser } });
    await click('[data-testid="block-confirm"]');
    expect(text('.error')).toContain(message);
    expect(q('.error')?.getAttribute('role')).toBe('alert');
    expect(wrapper.emitted('blocked')).toBeUndefined();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(q<HTMLButtonElement>('[data-testid="block-confirm"]')?.disabled).toBe(false);

    await click('[data-testid="block-confirm"]');
    expect(blockUser).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('blocked')).toEqual([[false]]);
  });

  it('never shows the server wording of an error', async () => {
    const blockUser = vi.fn().mockRejectedValue(new PermissionDeniedError('Administrator account'));
    await open({ api: { blockUser } });
    await click('[data-testid="block-confirm"]');
    expect(text('.error')).not.toContain('Administrator account');
  });

  it('starts from the safe default every time it is opened', async () => {
    const { wrapper } = await open();
    radio('remove').click();
    await flushPromises();
    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(radio('only').checked).toBe(true);
  });
});

describe('removal status for a manager who may not read it', () => {
  it('shows the uniform forbidden message', async () => {
    const removalStatus = vi
      .fn<StaffUsersApi['removalStatus']>()
      .mockRejectedValue(new PermissionDeniedError());
    await open({ api: { removalStatus } });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    expect(text('[data-testid="removal-status"] [role="alert"]')).toContain("ruxsat yo'q");
  });
});

describe('removal items', () => {
  it('lists each group with its own status', async () => {
    const items: GroupRemovalItem[] = [
      {
        organizationId: fakeUuid('g1'),
        organizationName: 'Group One',
        status: 'DONE',
        errorCode: null,
        maybeBanned: false,
        requestedAt: '2026-10-19T04:30:00.000Z',
        completedAt: '2026-10-19T04:31:00.000Z',
      },
      {
        organizationId: fakeUuid('g2'),
        organizationName: 'Group Two',
        status: 'FAILED',
        errorCode: 'CANNOT_REMOVE_MEMBER',
        maybeBanned: false,
        requestedAt: '2026-10-19T04:30:00.000Z',
        completedAt: '2026-10-19T04:31:00.000Z',
      },
    ];
    await open({ api: { removalStatus: vi.fn(async () => items) } });
    radio('remove').click();
    await flushPromises();
    await click('[data-testid="block-confirm"]');
    const rows = Array.from(document.body.querySelectorAll('.item')).map((e) =>
      squash(e.textContent),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Group One');
    expect(rows[0]).toContain('Chiqarildi');
    expect(rows[1]).toContain('Group Two');
    expect(rows[1]).toContain('Bajarilmadi');
    // Nothing to fix for CANNOT_REMOVE_MEMBER: no retry button.
    expect(q('[data-testid="removal-retry"]')).toBeNull();
  });
});
