// Types and constants shared by api and web live here (CLAUDE.md: do not duplicate them).
// Timezone used for all business time rules; timestamps themselves are stored in UTC.
export const BUSINESS_TIME_ZONE = 'Asia/Tashkent';

/** So'm added to the Central Bank's rate when it is the rate in force [C, owner 2026-10-31]. */
export const USD_RATE_BANK_MARKUP_UZS = 40;

export * from './roles.js';
export * from './order-status.js';
export * from './mini-app-start.js';
export * from './contracts/index.js';

export * from './contracts/customer-auth.js';
