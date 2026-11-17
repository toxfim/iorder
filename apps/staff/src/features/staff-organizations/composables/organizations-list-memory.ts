import { ORGANIZATION_LABELS, ORGANIZATION_TYPES } from '@iorder/shared';
import type { LocationQuery, LocationQueryRaw, RouteLocationRaw } from 'vue-router';
import type {
  OrganizationLabelFilter,
  OrganizationStatusFilter,
  OrganizationTypeFilter,
} from '../domain/organization-model';

/**
 * The organizations list keeps its search and filters in the URL query, so browser back, a
 * reload and a shared link all show the same list. Defaults are left out of the URL.
 */
export interface OrganizationListFilters {
  readonly search: string;
  readonly status: OrganizationStatusFilter;
  readonly type: OrganizationTypeFilter;
  readonly label: OrganizationLabelFilter;
  /** The archive instead of the list [C, owner 2026-11-13]; `archived=1` in the URL. */
  readonly archived: boolean;
}

const STATUS_FILTERS: readonly OrganizationStatusFilter[] = ['ACTIVE', 'INACTIVE', 'UNLINKED'];

const single = (value: LocationQuery[string] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | 'all' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : 'all';
}

/** Unknown values (an old or hand-edited link) read as "all", never as an error. */
export function filtersFromQuery(query: LocationQuery): OrganizationListFilters {
  return {
    search: single(query.q) ?? '',
    status: oneOf(single(query.status), STATUS_FILTERS),
    type: oneOf(single(query.type), ORGANIZATION_TYPES),
    label: oneOf(single(query.label), ORGANIZATION_LABELS),
    archived: single(query.archived) === '1',
  };
}

export function queryOfFilters(filters: OrganizationListFilters): LocationQueryRaw {
  return {
    ...(filters.search !== '' ? { q: filters.search } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.type !== 'all' ? { type: filters.type } : {}),
    ...(filters.label !== 'all' ? { label: filters.label } : {}),
    ...(filters.archived ? { archived: '1' } : {}),
  };
}

/** Where the list stood when an organization was opened from it. */
export interface OrganizationsListScroll {
  /** The page's own scroll (the document scrolls in the staff shell). */
  readonly windowY: number;
  /** The table's own scroll box (wide screens: the table scrolls inside a 72vh box). */
  readonly tableTop: number;
}

interface Memory extends OrganizationsListScroll {
  readonly fullPath: string;
}

// One list, one memory, for this tab only: nothing to persist across reloads.
let memory: Memory | null = null;
// Set only by a way BACK (the detail page's back link, the browser's back): a deliberate click to
// the list (sidebar, dashboard card) opens it at the top [review 2026-11-12].
let returning = false;

/** The list remembers itself when it opens an organization (list -> detail). */
export function rememberOrganizationsList(next: Memory): void {
  memory = next;
  returning = false;
}

/** Any other way out (list -> elsewhere, detail -> elsewhere) starts the list fresh next time. */
export function forgetOrganizationsList(): void {
  memory = null;
  returning = false;
}

/** The next arrival at the list is a return: the back link was used or history went back. */
export function markOrganizationsListReturn(): void {
  if (memory !== null) returning = true;
}

/** The detail page's back link returns to the list as it was, filters included. */
export function organizationsListLocation(): RouteLocationRaw {
  return memory?.fullPath ?? { name: 'staff-organizations' };
}

/**
 * The scroll to restore when the list opens at the place it was left (detail -> back). One-shot:
 * the memory is used up; a list reached any other way, or at another address (other filters),
 * starts at the top.
 */
export function takeOrganizationsListScroll(fullPath: string): OrganizationsListScroll | null {
  const found = memory;
  const back = returning;
  forgetOrganizationsList();
  if (found === null || !back || found.fullPath !== fullPath) return null;
  return { windowY: found.windowY, tableTop: found.tableTop };
}
