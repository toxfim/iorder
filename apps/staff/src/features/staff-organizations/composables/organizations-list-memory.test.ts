import { afterEach, describe, expect, it } from 'vitest';
import {
  filtersFromQuery,
  forgetOrganizationsList,
  organizationsListLocation,
  queryOfFilters,
  markOrganizationsListReturn,
  rememberOrganizationsList,
  takeOrganizationsListScroll,
} from './organizations-list-memory';

afterEach(() => forgetOrganizationsList());

describe('organizations list filters in the URL', () => {
  it('round-trips the filters and leaves the defaults out', () => {
    const filters = {
      search: 'bux',
      status: 'UNLINKED',
      type: 'PERSON',
      label: 'PARTNER',
      archived: true,
    } as const;
    const query = queryOfFilters(filters);
    expect(query).toEqual({
      q: 'bux',
      status: 'UNLINKED',
      type: 'PERSON',
      label: 'PARTNER',
      archived: '1',
    });
    expect(filtersFromQuery(query as Record<string, string>)).toEqual(filters);
    expect(
      queryOfFilters({ search: '', status: 'all', type: 'all', label: 'all', archived: false }),
    ).toEqual({});
  });

  it('reads unknown or repeated values safely', () => {
    expect(filtersFromQuery({ status: 'nope', type: ['GROUP', 'PERSON'], label: null })).toEqual({
      search: '',
      status: 'all',
      type: 'GROUP',
      label: 'all',
      archived: false,
    });
  });
});

describe('organizations list memory', () => {
  it('gives the scroll back once, and only to the same list address', () => {
    rememberOrganizationsList({ fullPath: '/staff/organizations?q=a', windowY: 400, tableTop: 80 });
    expect(organizationsListLocation()).toBe('/staff/organizations?q=a');
    markOrganizationsListReturn();
    expect(takeOrganizationsListScroll('/staff/organizations?q=a')).toEqual({
      windowY: 400,
      tableTop: 80,
    });
    expect(takeOrganizationsListScroll('/staff/organizations?q=a')).toBeNull();
    expect(organizationsListLocation()).toEqual({ name: 'staff-organizations' });

    rememberOrganizationsList({ fullPath: '/staff/organizations?q=a', windowY: 400, tableTop: 0 });
    markOrganizationsListReturn();
    expect(takeOrganizationsListScroll('/staff/organizations')).toBeNull();
  });

  it('a list reached without a way back (sidebar, dashboard) starts at the top', () => {
    rememberOrganizationsList({ fullPath: '/staff/organizations', windowY: 400, tableTop: 0 });
    expect(takeOrganizationsListScroll('/staff/organizations')).toBeNull();
    // A return mark without a remembered list means nothing either.
    markOrganizationsListReturn();
    expect(takeOrganizationsListScroll('/staff/organizations')).toBeNull();
  });

  it('forgets on any other way out', () => {
    rememberOrganizationsList({ fullPath: '/staff/organizations', windowY: 10, tableTop: 0 });
    forgetOrganizationsList();
    expect(takeOrganizationsListScroll('/staff/organizations')).toBeNull();
  });
});
