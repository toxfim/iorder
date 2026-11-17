import { STAFF_ROLES, type StaffRole } from '@iorder/shared';

// UI convenience only. The api enforces every one of these rules and answers 403 otherwise.

/** The roles the viewer may put on a new account: only an administrator grants ADMIN. */
export function assignableRoles(viewerRoles: readonly StaffRole[]): readonly StaffRole[] {
  return viewerRoles.includes('ADMIN') ? STAFF_ROLES : STAFF_ROLES.filter((r) => r !== 'ADMIN');
}

/** MANAGE_STAFF_ACCOUNTS: everyone else on the page only reads the directory. */
export const canManageAccounts = (viewerRoles: readonly StaffRole[]): boolean =>
  viewerRoles.includes('ADMIN') || viewerRoles.includes('MANAGER');

/** A manager cannot change an administrator's login, password or Telegram link. */
export function mayChangeAccount(
  viewerRoles: readonly StaffRole[],
  target: { readonly roles: readonly StaffRole[] },
): boolean {
  return viewerRoles.includes('ADMIN') || !target.roles.includes('ADMIN');
}

/** Blocking a staff account needs an administrator (the server's MANAGE_STAFF). */
export const maySetAccountStatus = (viewerRoles: readonly StaffRole[]): boolean =>
  viewerRoles.includes('ADMIN');
