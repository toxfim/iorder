// Entry point `@iorder/shared/staff-auth`: STAFF-ONLY website sign-in contracts. Deliberately NOT
// re-exported from the package barrel (`@iorder/shared`) so the customer web bundle cannot pull
// staff sign-in vocabulary or route paths in by accident. Also the staff bot notification contracts
// and a staff member's own profile.
export * from './contracts/staff-auth.js';
export * from './contracts/staff-notifications.js';
export * from './contracts/staff-profile.js';
