// Entry point `@iorder/shared/staff-orders`: STAFF-ONLY order contracts (hard rule 7). Deliberately
// NOT re-exported from the package barrel (`@iorder/shared`) so the customer web bundle cannot
// pull the accounting vocabulary, staff DTOs or staff route paths in by accident. The staff area
// of apps/staff may import this entry; an ESLint rule keeps every other web code away from it and
// the web bundle check fails when a customer chunk contains staff-order vocabulary.
export * from './contracts/staff-orders.js';
export * from './contracts/staff-dashboard.js';
export * from './contracts/staff-users.js';
export * from './contracts/unit-codes.js';
export * from './contracts/organization-payments.js';
