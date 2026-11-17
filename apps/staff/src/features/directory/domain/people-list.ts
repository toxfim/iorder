import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import type { MemberView, OrganizationView } from './directory-model';

/**
 * Mijozlar lists PEOPLE [owner 2026-11-13]: the members of the organizations (shop owners and
 * sellers) and the customers of PERSON organizations. The organizations themselves live on
 * Tashkilotlar.
 */
export interface PersonRow {
  readonly member: MemberView;
  readonly organization: OrganizationView;
}

/** `members`: people of a Telegram group; `persons`: the customer of a PERSON organization. */
export type PeopleKindFilter = 'all' | 'members' | 'persons';
export type PeopleStatusFilter = 'all' | 'active' | 'blocked';

export interface PeopleFilters {
  readonly search: string;
  /** An organization id, or 'all'. */
  readonly organization: string;
  readonly kind: PeopleKindFilter;
  readonly status: PeopleStatusFilter;
}

export const ALL_ORGANIZATIONS = 'all';

/**
 * Joins each member with their organization. A member whose organization is not in the list is
 * left out: the directory reads the default organization list, which leaves archived ones out,
 * so their people disappear with them [P].
 */
export function peopleRows(
  members: readonly MemberView[],
  organizations: readonly OrganizationView[],
): PersonRow[] {
  const byId = new Map(organizations.map((o) => [o.id, o]));
  return members
    .flatMap((member) => {
      const organization = byId.get(member.organizationId);
      return organization ? [{ member, organization }] : [];
    })
    .sort(
      (a, b) =>
        a.member.name.localeCompare(b.member.name) || a.member.id.localeCompare(b.member.id),
    );
}

const matchesKind = (row: PersonRow, kind: PeopleKindFilter): boolean =>
  kind === 'all' || (kind === 'persons') === (row.organization.type === 'PERSON');

const matchesStatus = (row: PersonRow, status: PeopleStatusFilter): boolean =>
  status === 'all' || (status === 'active') === row.member.isActive;

/** Search over the name, the phone (digits, from three on) and the organization's name. */
function matchesSearch(row: PersonRow, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === '') return true;
  const digits = needle.replace(/\D/g, '');
  return (
    row.member.name.toLocaleLowerCase().includes(needle) ||
    row.organization.name.toLocaleLowerCase().includes(needle) ||
    (digits.length >= 3 && row.member.phone.replace(/\D/g, '').includes(digits))
  );
}

export function filterPeople(rows: readonly PersonRow[], filters: PeopleFilters): PersonRow[] {
  return rows.filter(
    (row) =>
      (filters.organization === ALL_ORGANIZATIONS ||
        row.organization.id === filters.organization) &&
      matchesKind(row, filters.kind) &&
      matchesStatus(row, filters.status) &&
      matchesSearch(row, filters.search),
  );
}

// --- the filters in the URL (replace, like Tashkilotlar) ---------------------------------------

const KINDS: readonly PeopleKindFilter[] = ['members', 'persons'];
const STATUSES: readonly PeopleStatusFilter[] = ['active', 'blocked'];

const single = (value: LocationQuery[string] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | 'all' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : 'all';
}

/** Unknown values (an old or hand-edited link) read as "all", never as an error. */
export function peopleFiltersFromQuery(query: LocationQuery): PeopleFilters {
  return {
    search: single(query.q) ?? '',
    organization: single(query.org) || ALL_ORGANIZATIONS,
    kind: oneOf(single(query.kind), KINDS),
    status: oneOf(single(query.status), STATUSES),
  };
}

export function queryOfPeopleFilters(filters: PeopleFilters): LocationQueryRaw {
  return {
    ...(filters.search !== '' ? { q: filters.search } : {}),
    ...(filters.organization !== ALL_ORGANIZATIONS ? { org: filters.organization } : {}),
    ...(filters.kind !== 'all' ? { kind: filters.kind } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
  };
}
