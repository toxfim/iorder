import { newStaffPasswordSchema } from '@iorder/shared/staff-auth';
import type { GroupRemovalItem } from '@iorder/shared/staff-orders';
import { GROUP_REMOVAL_ERROR_CODES } from '@iorder/shared/staff-orders';
import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiRateLimitedError,
  ApiValidationError,
  NetworkError,
  PermissionDeniedError,
  UnauthenticatedError,
} from '@core/lib/api-errors';
import { staffUsersMessages } from './messages';
import type { StaffUsersApi } from './api/staff-users-api';
import { assignableRoles, mayChangeAccount, maySetAccountStatus } from './domain/account-rules';
import { errorTextFor } from './domain/error-text';
import { generateStrongPassword } from './domain/password-generator';
import { isRetryable, maybeBanned, reasonKey } from './domain/removal-reasons';
import { MAX_POLLS, POLL_DELAYS_MS, useRemovalStatus } from './composables/use-removal-status';

const item = (over: Partial<GroupRemovalItem> = {}): GroupRemovalItem => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  organizationName: 'Orion Mobile',
  status: 'PENDING',
  errorCode: null,
  maybeBanned: false,
  requestedAt: '2026-10-19T04:30:00.000Z',
  completedAt: null,
  ...over,
});

describe('generateStrongPassword', () => {
  it('makes a password the server accepts, from the crypto source, with no look-alike characters', () => {
    const password = generateStrongPassword();
    expect(newStaffPasswordSchema.safeParse(password).success).toBe(true);
    expect(password).toHaveLength(20);
    expect(password).not.toMatch(/[0OIl1]/);
  });

  it('draws only from the injected random source and never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const random = vi.fn((array: Uint32Array<ArrayBuffer>) => array.fill(5));
    expect(generateStrongPassword(8, random)).toHaveLength(8);
    expect(random).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips values that would bias the choice (rejection sampling)', () => {
    let calls = 0;
    const random = (array: Uint32Array<ArrayBuffer>) => {
      calls += 1;
      // The first batch is all out of range, the second is fine.
      return array.fill(calls === 1 ? 0xffffffff : 1);
    };
    expect(generateStrongPassword(6, random)).toHaveLength(6);
    expect(calls).toBe(2);
  });

  it('gives different passwords on every call', () => {
    expect(generateStrongPassword()).not.toBe(generateStrongPassword());
  });
});

describe('account rules (UI convenience; the api enforces them)', () => {
  it('does not offer ADMIN to a manager, and offers every role to an administrator', () => {
    expect(assignableRoles(['MANAGER'])).not.toContain('ADMIN');
    expect(assignableRoles(['MANAGER'])).toHaveLength(5);
    expect(assignableRoles(['ADMIN'])).toContain('ADMIN');
    expect(assignableRoles(['ADMIN', 'MANAGER'])).toHaveLength(6);
  });

  it('keeps administrator accounts from a manager', () => {
    expect(mayChangeAccount(['MANAGER'], { roles: ['ADMIN'] })).toBe(false);
    expect(mayChangeAccount(['MANAGER'], { roles: ['ADMIN', 'MANAGER'] })).toBe(false);
    expect(mayChangeAccount(['MANAGER'], { roles: ['MANAGER'] })).toBe(true);
    expect(mayChangeAccount(['ADMIN'], { roles: ['ADMIN'] })).toBe(true);
  });

  it('lets only an administrator block a staff account', () => {
    expect(maySetAccountStatus(['ADMIN'])).toBe(true);
    expect(maySetAccountStatus(['MANAGER'])).toBe(false);
  });
});

describe('errorTextFor', () => {
  it('maps each failure kind to one text key and never to the server wording', () => {
    expect(errorTextFor(new PermissionDeniedError('secret detail')).key).toBe('forbidden');
    expect(errorTextFor(new UnauthenticatedError()).key).toBe('forbidden');
    expect(errorTextFor(new ApiNotFoundError('x', 'NOT_FOUND')).key).toBe('notFound');
    expect(errorTextFor(new ApiConflictError('x', 'CONFLICT')).key).toBe('conflict');
    expect(errorTextFor(new ApiConflictError('x', 'CONFLICT', {}, 'EMPTY_DRAFT')).key).toBe(
      'conflict',
    );
    expect(errorTextFor(new ApiConflictError('x', 'CONFLICT', {}, 'LAST_ADMIN')).key).toBe(
      'lastAdmin',
    );
    expect(
      errorTextFor(new ApiConflictError('x', 'CONFLICT', {}, 'TELEGRAM_ID_REQUIRED')).key,
    ).toBe('telegramIdRequired');
    expect(errorTextFor(new ApiValidationError('x', 'V', [])).key).toBe('invalid');
    expect(errorTextFor(new NetworkError()).key).toBe('generic');
    expect(errorTextFor(new Error('boom')).key).toBe('generic');
    expect(errorTextFor(new ApiRateLimitedError('x', 'TOO_MANY_REQUESTS', 12))).toEqual({
      key: 'rateLimited',
      params: { seconds: 12 },
    });
  });
});

describe('error texts', () => {
  it.each(['uz', 'ru', 'en'] as const)(
    '%s: the 409 texts for the membership reasons exist',
    (lang) => {
      const errors = staffUsersMessages[lang].errors as Record<string, string>;
      for (const reason of ['LAST_ADMIN', 'TELEGRAM_ID_REQUIRED'] as const) {
        const key = errorTextFor(new ApiConflictError('x', 'CONFLICT', {}, reason)).key;
        expect(errors[key], reason).toBeTruthy();
        expect(errors[key], reason).not.toBe(errors.conflict);
      }
    },
  );
});

describe('removal reasons', () => {
  it.each(['uz', 'ru', 'en'] as const)('%s: every code has a plain-language text', (lang) => {
    const reasons = staffUsersMessages[lang].removal.reason as Record<string, string>;
    for (const code of GROUP_REMOVAL_ERROR_CODES) {
      const text = reasons[reasonKey(code)];
      expect(text, code).toBeTruthy();
      expect(text, code).not.toContain(code);
    }
    expect(reasons[reasonKey(null)]).toBeTruthy();
  });

  it('knows every code the server can send, so none falls back to the unknown text', () => {
    for (const code of GROUP_REMOVAL_ERROR_CODES) expect(reasonKey(code), code).toBe(code);
  });

  it.each(['NO_RECIPIENT', 'INVALID_PAYLOAD'] as const)('%s is not retryable', (code) => {
    expect(isRetryable(item({ status: 'FAILED', errorCode: code }))).toBe(false);
  });

  it('offers a retry only where blocking again can help', () => {
    const failed = (errorCode: GroupRemovalItem['errorCode']) =>
      isRetryable(item({ status: 'FAILED', errorCode }));
    for (const code of [
      'BOT_NOT_ADMIN',
      'REMOVAL_REJECTED',
      'RATE_LIMITED_TOO_LONG',
      'RETRIES_EXHAUSTED',
      'CHAT_MIGRATED',
    ] as const) {
      expect(failed(code), code).toBe(true);
    }
    for (const code of [
      'NOT_A_MEMBER',
      'CANNOT_REMOVE_MEMBER',
      'REMOVAL_NOT_ALLOWED',
      'UNBAN_FAILED',
      null,
    ] as const) {
      expect(failed(code), String(code)).toBe(false);
    }
    expect(isRetryable(item({ status: 'PENDING', errorCode: 'BOT_NOT_ADMIN' }))).toBe(false);
    expect(isRetryable(item({ status: 'DONE' }))).toBe(false);
  });

  it('warns about a ban from the flag or from the code', () => {
    expect(maybeBanned(item({ maybeBanned: true }))).toBe(true);
    expect(maybeBanned(item({ status: 'FAILED', errorCode: 'UNBAN_FAILED' }))).toBe(true);
    expect(maybeBanned(item({ status: 'FAILED', errorCode: 'BOT_NOT_ADMIN' }))).toBe(false);
  });
});

describe('useRemovalStatus (gentle polling)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function apiWith(answers: (readonly GroupRemovalItem[])[]) {
    let reads = 0;
    const removalStatus = vi.fn<StaffUsersApi['removalStatus']>(async () => {
      reads += 1;
      return answers[Math.min(reads - 1, answers.length - 1)]!;
    });
    const api: StaffUsersApi = {
      blockUser: vi.fn(),
      unblockUser: vi.fn(),
      removalStatus,
    };
    return { api, removalStatus };
  }

  it('reads once and does not poll when nothing is waiting', async () => {
    const { api, removalStatus } = apiWith([[item({ status: 'DONE' })]]);
    const scope = effectScope();
    const status = scope.run(() => useRemovalStatus(api, () => 'u1'))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(status.state.value).toBe('ready');
    expect(status.watching.value).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removalStatus).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('keeps reading with growing waits while PENDING and stops once settled', async () => {
    const { api, removalStatus } = apiWith([
      [item()],
      [item()],
      [item({ status: 'DONE', completedAt: '2026-10-19T04:31:00.000Z' })],
    ]);
    const scope = effectScope();
    const status = scope.run(() => useRemovalStatus(api, () => 'u1'))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(removalStatus).toHaveBeenCalledTimes(1);
    expect(status.watching.value).toBe(true);

    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]! - 1);
    expect(removalStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(removalStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[1]!);
    expect(removalStatus).toHaveBeenCalledTimes(3);
    expect(status.items.value[0]?.status).toBe('DONE');
    expect(status.watching.value).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(removalStatus).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  it('stops when the owner goes away (no timer outlives the page)', async () => {
    const { api, removalStatus } = apiWith([[item()]]);
    const scope = effectScope();
    scope.run(() => useRemovalStatus(api, () => 'u1'));
    await vi.advanceTimersByTimeAsync(0);
    scope.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(removalStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on an error, keeps the last rows and restarts with a manual refresh', async () => {
    const removalStatus = vi
      .fn<StaffUsersApi['removalStatus']>()
      .mockResolvedValueOnce([item()])
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue([item({ status: 'DONE' })]);
    const api: StaffUsersApi = { blockUser: vi.fn(), unblockUser: vi.fn(), removalStatus };
    const scope = effectScope();
    const status = scope.run(() => useRemovalStatus(api, () => 'u1'))!;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]!);
    expect(status.state.value).toBe('error');
    expect(status.items.value).toHaveLength(1);
    expect(status.watching.value).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removalStatus).toHaveBeenCalledTimes(2);

    await status.refresh();
    expect(status.state.value).toBe('ready');
    expect(status.items.value[0]?.status).toBe('DONE');
    scope.stop();
  });

  it('reports a 403 as denied', async () => {
    const api: StaffUsersApi = {
      blockUser: vi.fn(),
      unblockUser: vi.fn(),
      removalStatus: vi.fn().mockRejectedValue(new PermissionDeniedError()),
    };
    const scope = effectScope();
    const status = scope.run(() => useRemovalStatus(api, () => 'u1'))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(status.state.value).toBe('denied');
    scope.stop();
  });

  it('gives up after MAX_POLLS reads and says so', async () => {
    const { api, removalStatus } = apiWith([[item()]]);
    const scope = effectScope();
    const status = scope.run(() => useRemovalStatus(api, () => 'u1'))!;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MAX_POLLS * 20_000);
    expect(status.stalled.value).toBe(true);
    expect(status.watching.value).toBe(false);
    expect(removalStatus).toHaveBeenCalledTimes(MAX_POLLS + 1);
    scope.stop();
  });

  it('does not read while the tab is hidden', async () => {
    const { api, removalStatus } = apiWith([[item()]]);
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    const scope = effectScope();
    scope.run(() => useRemovalStatus(api, () => 'u1'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removalStatus).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(removalStatus.mock.calls.length).toBeGreaterThan(1);
    scope.stop();
    Reflect.deleteProperty(document, 'visibilityState');
  });
});
