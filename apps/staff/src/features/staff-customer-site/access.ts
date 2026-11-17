import type { StaffRole } from '@iorder/shared';

/**
 * Who may continue on the customer site with their dashboard sign-in ([C] 2026-11-09): the staff
 * roles that may be viewers there (the server's OPEN_CUSTOMER_SITE, i.e. the roles that browse the
 * price list). The warehouse and the driver never see a price, so they are not viewers. UI
 * convenience only: the server decides on every request.
 */
export const CUSTOMER_SITE_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ACCOUNTANT',
  'ADMIN',
  'PURCHASING_MANAGER',
];

export function mayOpenCustomerSite(roles: readonly StaffRole[]): boolean {
  return roles.some((role) => CUSTOMER_SITE_ROLES.includes(role));
}
