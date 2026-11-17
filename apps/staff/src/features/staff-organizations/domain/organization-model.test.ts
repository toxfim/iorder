import type { StaffOrganizationSummary } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  countWaiting,
  describeOrganizationError,
  displayStatusOf,
  filterOrganizations,
  inviteTimeLeft,
  sortInactiveFirst,
} from './organization-model';

const org = (
  name: string,
  status: 'ACTIVE' | 'INACTIVE',
  createdAt: string,
  chat = '-100200',
  extra: Partial<StaffOrganizationSummary> = {},
): StaffOrganizationSummary => ({
  id: fakeUuid(name),
  name,
  type: 'GROUP',
  label: 'STANDARD',
  priceTier: 'STANDARD',
  phone: null,
  invite: { status: 'LINKED', expiresAt: null },
  boundPerson: null,
  typeChangeable: false,
  telegramChatId: chat,
  status,
  pricePostingEnabled: false,
  activeMemberCount: 0,
  shopOwner: null,
  addedBy: null,
  archivedAt: null,
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

const list = [
  org('Zeta', 'ACTIVE', '2026-01-01T00:00:00.000Z'),
  org('Alpha', 'ACTIVE', '2026-01-02T00:00:00.000Z'),
  org('Old group', 'INACTIVE', '2026-09-01T00:00:00.000Z'),
  org('New group', 'INACTIVE', '2026-10-20T00:00:00.000Z', '-100999'),
];

describe('sortInactiveFirst', () => {
  it('puts inactive first (newest first), then active by name, without mutating the input', () => {
    const before = list.map((o) => o.name);
    expect(sortInactiveFirst(list).map((o) => o.name)).toEqual([
      'New group',
      'Old group',
      'Alpha',
      'Zeta',
    ]);
    expect(list.map((o) => o.name)).toEqual(before);
  });
});

const pending = org('Dilnoza', 'INACTIVE', '2026-11-11T00:00:00.000Z', '', {
  type: 'PERSON',
  label: 'PARTNER',
  priceTier: 'WHOLESALE_PARTNER',
  telegramChatId: null,
  phone: '+998901234567',
  invite: { status: 'PENDING', expiresAt: '2026-11-18T00:00:00.000Z' },
});
const expired = org('Old link', 'INACTIVE', '2026-11-01T00:00:00.000Z', '', {
  label: 'WHOLESALE',
  priceTier: 'WHOLESALE_PARTNER',
  telegramChatId: null,
  invite: { status: 'EXPIRED', expiresAt: '2026-11-08T00:00:00.000Z' },
});
const withInvites = [...list, pending, expired];
const search = (term: string) =>
  filterOrganizations(withInvites, { search: term, status: 'all' }).map((o) => o.name);

describe('filterOrganizations', () => {
  it('filters by status: waiting = bound and inactive, unlinked = no chat yet', () => {
    expect(
      filterOrganizations(withInvites, { search: '', status: 'INACTIVE' }).map((o) => o.name),
    ).toEqual(['Old group', 'New group']);
    expect(
      filterOrganizations(withInvites, { search: '', status: 'UNLINKED' }).map((o) => o.name),
    ).toEqual(['Dilnoza', 'Old link']);
    expect(filterOrganizations(withInvites, { search: '', status: 'all' })).toHaveLength(6);
  });

  it('filters by type and by label', () => {
    expect(
      filterOrganizations(withInvites, { search: '', status: 'all', type: 'PERSON' }).map(
        (o) => o.name,
      ),
    ).toEqual(['Dilnoza']);
    expect(
      filterOrganizations(withInvites, { search: '', status: 'all', label: 'WHOLESALE' }).map(
        (o) => o.name,
      ),
    ).toEqual(['Old link']);
  });

  it('searches the name (any case), the chat id and the phone digits', () => {
    expect(search('  ALPH ')).toEqual(['Alpha']);
    expect(search('-100999')).toEqual(['New group']);
    expect(search('90 123')).toEqual(['Dilnoza']);
    expect(search('zzz')).toEqual([]);
  });
});

describe('countWaiting', () => {
  it('counts the bound inactive ones only', () => expect(countWaiting(withInvites)).toBe(2));
  it('never counts an archived one [C, owner 2026-11-13]', () =>
    expect(
      countWaiting([
        ...withInvites,
        org('Archived', 'INACTIVE', '2026-10-01T00:00:00.000Z', '-100777', {
          archivedAt: '2026-10-02T00:00:00.000Z',
        }),
      ]),
    ).toBe(2));
});

describe('displayStatusOf', () => {
  it('shows the invite state while nothing is bound', () => {
    expect(displayStatusOf(pending)).toBe('PENDING');
    expect(displayStatusOf(expired)).toBe('EXPIRED');
    expect(displayStatusOf(list[0]!)).toBe('ACTIVE');
    expect(displayStatusOf(list[2]!)).toBe('INACTIVE');
  });
});

describe('inviteTimeLeft', () => {
  const now = new Date('2026-11-11T01:00:00.000Z');
  it('counts whole days and hours, and null once it ran out', () => {
    expect(inviteTimeLeft('2026-11-18T00:30:00.000Z', now)).toEqual({ days: 6, hours: 23 });
    expect(inviteTimeLeft('2026-11-11T00:59:00.000Z', now)).toBeNull();
    expect(inviteTimeLeft(null, now)).toBeNull();
  });
});

describe('describeOrganizationError', () => {
  it('maps each failure to a message key and says whether to re-read', () => {
    expect(describeOrganizationError(new PermissionDeniedError())).toEqual({
      key: 'apiErrors.denied',
      reload: false,
    });
    expect(describeOrganizationError(new ApiNotFoundError('x', 'NOT_FOUND'))).toEqual({
      key: 'organizations.errors.gone',
      reload: true,
    });
    expect(describeOrganizationError(new ApiConflictError('x', 'CONFLICT'))).toEqual({
      key: 'organizations.errors.conflict',
      reload: true,
    });
    const conflict = (
      reason:
        | 'ORGANIZATION_NOT_LINKED'
        | 'ORGANIZATION_ALREADY_LINKED'
        | 'PERSON_ORGANIZATION'
        | 'ORGANIZATION_ARCHIVED',
    ) => describeOrganizationError(new ApiConflictError('x', 'CONFLICT', undefined, reason));
    expect(conflict('ORGANIZATION_NOT_LINKED')).toEqual({
      key: 'apiErrors.organizationNotLinked',
      reload: true,
    });
    expect(conflict('ORGANIZATION_ALREADY_LINKED').key).toBe('apiErrors.organizationAlreadyLinked');
    expect(conflict('PERSON_ORGANIZATION').key).toBe('apiErrors.personOrganization');
    expect(conflict('ORGANIZATION_ARCHIVED')).toEqual({
      key: 'apiErrors.organizationArchived',
      reload: true,
    });
    expect(describeOrganizationError(new ApiValidationError('x', 'VALIDATION', [])).key).toBe(
      'apiErrors.validation',
    );
    expect(describeOrganizationError(new RequestTimeoutError()).key).toBe('apiErrors.timeout');
    expect(describeOrganizationError(new NetworkError()).key).toBe('apiErrors.network');
    expect(describeOrganizationError(new Error('boom')).key).toBe('apiErrors.generic');
  });
});
