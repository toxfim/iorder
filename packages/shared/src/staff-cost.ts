// Entry point `@iorder/shared/staff-cost`: STAFF-ONLY cost contracts (hard rule 7). Deliberately
// NOT re-exported from the package barrel (`@iorder/shared`) so the customer web bundle cannot
// pull cost key names or cost route paths in by accident. The staff app (apps/staff) may import
// this entry; an ESLint rule keeps every other web code away from it.
export * from './contracts/cost.js';
export * from './contracts/staff-catalog.js';
export * from './contracts/category-code-rule.js';
export * from './contracts/sheet-sync-runs.js';
export * from './contracts/brands.js';
export * from './contracts/supply-parties.js';
export * from './contracts/manual-products.js';
export * from './contracts/product-successions.js';
