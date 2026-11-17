import type { StaffRole } from '@iorder/shared';

// Who may list, open, activate and deactivate organizations: the server's EDIT_CUSTOMERS
// permission (manager and admin). UI convenience only; every api route re-checks it.
export const ORGANIZATION_STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'MANAGER'];

/** Who reads them (VIEW_CUSTOMERS); the purchasing manager changes nothing. */
export const ORGANIZATION_VIEW_ROLES: readonly StaffRole[] = [
  'ADMIN',
  'MANAGER',
  'PURCHASING_MANAGER',
];

export const canViewOrganizations = (roles: readonly StaffRole[]): boolean =>
  roles.some((role) => ORGANIZATION_VIEW_ROLES.includes(role));

export const canManageOrganizations = (roles: readonly StaffRole[]): boolean =>
  roles.some((role) => ORGANIZATION_STAFF_ROLES.includes(role));

/**
 * Who changes the label of an existing organization: the admin alone [C, owner 2026-11-12] (the
 * server's CHANGE_ORGANIZATION_LABEL). The manager still picks the label when creating one.
 */
export const canChangeOrganizationLabel = (roles: readonly StaffRole[]): boolean =>
  roles.includes('ADMIN');

/**
 * Who "deletes" (archives) and restores an organization: the admin alone [C, owner 2026-11-13]
 * (the server's ARCHIVE_ORGANIZATION). Archiving never deletes: the history stays.
 */
export const canArchiveOrganizations = (roles: readonly StaffRole[]): boolean =>
  roles.includes('ADMIN');
