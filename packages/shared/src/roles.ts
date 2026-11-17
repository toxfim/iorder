// Source: docs/domain/order-lifecycle.md §5 and docs/domain/data-model.md (user_roles, organization_members).
// `dev` is intentionally absent: it is not a confirmed application role (lifecycle Q9).

export const STAFF_ROLES = [
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'PURCHASING_MANAGER',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ORGANIZATION_ROLES = ['SHOP_OWNER', 'SELLER'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const LOCALES = ['UZ', 'RU', 'EN'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'UZ';
