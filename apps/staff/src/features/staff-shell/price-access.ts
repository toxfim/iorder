import type { StaffRole } from '@iorder/shared';

// Who may see and change prices and cost (docs/domain/order-lifecycle.md §5). UI convenience
// only: the server enforces every one of these, hiding a column or a button is not security.
// Kept here, outside the staff-cost chunk, because the router and the nav config read it at
// startup and must not pull cost code into the customer bundle.

/** Who may view cost, stock, the USD rate and sync reports. */
export const COST_VIEW_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ACCOUNTANT',
  'ADMIN',
  'PURCHASING_MANAGER',
];

/**
 * Manager and admin change selling prices, the USD rate and removal requests. The accountant
 * never changes selling prices (confirmed 2026-10-20).
 */
export const PRICE_EDITOR_ROLES: readonly StaffRole[] = ['MANAGER', 'ADMIN'];

/** Who reads the price management pages (VIEW_PRICE_ADMIN); the purchasing manager changes nothing. */
export const PRICE_ADMIN_VIEW_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ADMIN',
  'PURCHASING_MANAGER',
];

/** Who may press "sync now" (RUN_SHEET_SYNC). */
export const SHEET_SYNC_ROLES: readonly StaffRole[] = ['MANAGER', 'ADMIN', 'PURCHASING_MANAGER'];

const hasAny = (roles: readonly StaffRole[], allowed: readonly StaffRole[]): boolean =>
  roles.some((role) => allowed.includes(role));

export const canViewCost = (roles: readonly StaffRole[]): boolean => hasAny(roles, COST_VIEW_ROLES);

export const canEditPrices = (roles: readonly StaffRole[]): boolean =>
  hasAny(roles, PRICE_EDITOR_ROLES);

export const canViewPriceAdmin = (roles: readonly StaffRole[]): boolean =>
  hasAny(roles, PRICE_ADMIN_VIEW_ROLES);

export const canRunSheetSync = (roles: readonly StaffRole[]): boolean =>
  hasAny(roles, SHEET_SYNC_ROLES);

/** Manager and admin upload, switch and remove product photos (MANAGE_PRODUCT_IMAGES). */
export const PHOTO_MANAGER_ROLES: readonly StaffRole[] = ['MANAGER', 'ADMIN'];

export const canManagePhotos = (roles: readonly StaffRole[]): boolean =>
  hasAny(roles, PHOTO_MANAGER_ROLES);
