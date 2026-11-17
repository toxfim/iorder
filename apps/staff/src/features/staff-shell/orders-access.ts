import type { StaffRole } from '@iorder/shared';

/**
 * The roles whose screens (dashboard, order list, directory) see every order. They no longer
 * download it: the lists page on the server; the shell keeps the manager's queue for them.
 */
export function readsAllOrders(roles: readonly StaffRole[]): boolean {
  return (
    roles.includes('MANAGER') || roles.includes('ADMIN') || roles.includes('PURCHASING_MANAGER')
  );
}

/** The roles whose order view carries money and payment (the server's FULL view). */
export function seesOrderMoney(roles: readonly StaffRole[]): boolean {
  return readsAllOrders(roles) || roles.includes('ACCOUNTANT');
}
