import { describe, expect, it } from 'vitest';
import type { MemberView, OrganizationView } from './directory-model';
import {
  filterPeople,
  peopleFiltersFromQuery,
  peopleRows,
  queryOfPeopleFilters,
} from './people-list';

const org = (id: string, name: string, type: OrganizationView['type']): OrganizationView => ({
  id,
  name,
  type,
  address: '',
  phone: '',
  telegramGroup: '',
  isActive: true,
  since: '2026-01-01T00:00:00.000Z',
});
const member = (
  id: string,
  organizationId: string,
  name: string,
  isActive = true,
  phone = '',
): MemberView => ({
  id,
  organizationId,
  name,
  phone,
  telegramUsername: '',
  role: 'SELLER',
  isActive,
  joinedAt: '2026-01-01T00:00:00.000Z',
});

const orgs = [org('g', 'Guruh savdo', 'GROUP'), org('p', 'Vali Aliyev', 'PERSON')];
const members = [
  member('2', 'g', 'Zafar', false, '+998901112233'),
  member('1', 'g', 'Anvar'),
  member('3', 'p', 'Vali Aliyev'),
  // Its organization is archived, so it is not in the list.
  member('4', 'gone', 'Bekor'),
];

describe('people list', () => {
  it('joins people with their organization by name and drops those without one', () => {
    expect(peopleRows(members, orgs).map((r) => r.member.name)).toEqual([
      'Anvar',
      'Vali Aliyev',
      'Zafar',
    ]);
  });

  it('filters by organization, kind, status and search (name, organization, phone digits)', () => {
    const rows = peopleRows(members, orgs);
    const pick = (filters: Partial<Parameters<typeof filterPeople>[1]>): string[] =>
      filterPeople(rows, {
        search: '',
        organization: 'all',
        kind: 'all',
        status: 'all',
        ...filters,
      }).map((r) => r.member.name);
    expect(pick({ organization: 'g' })).toEqual(['Anvar', 'Zafar']);
    expect(pick({ kind: 'persons' })).toEqual(['Vali Aliyev']);
    expect(pick({ kind: 'members', status: 'blocked' })).toEqual(['Zafar']);
    expect(pick({ search: 'guruh' })).toEqual(['Anvar', 'Zafar']);
    expect(pick({ search: '111 22' })).toEqual(['Zafar']);
    // Too few digits never match every phone.
    expect(pick({ search: '9' })).toEqual([]);
  });

  it('round-trips the filters through the URL and reads unknown values as "all"', () => {
    const filters = { search: 'a', organization: 'g', kind: 'persons', status: 'active' } as const;
    const query = queryOfPeopleFilters(filters);
    expect(query).toEqual({ q: 'a', org: 'g', kind: 'persons', status: 'active' });
    expect(peopleFiltersFromQuery(query as Record<string, string>)).toEqual(filters);
    expect(peopleFiltersFromQuery({ kind: 'nope', status: ['blocked'] })).toEqual({
      search: '',
      organization: 'all',
      kind: 'all',
      status: 'blocked',
    });
    expect(
      queryOfPeopleFilters({ search: '', organization: 'all', kind: 'all', status: 'all' }),
    ).toEqual({});
  });
});
