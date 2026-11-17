import type { Env } from '../../config/env.js';

/** Owner rule 2026-10-30: 3 minutes from `submitted_at`, changeable by one env setting. */
export const DEFAULT_PAYMENT_PLAN_CHANGE_WINDOW_SECONDS = 3 * 60;

export function paymentPlanChangeWindowMs(
  env: Pick<Env, 'PAYMENT_PLAN_CHANGE_WINDOW_SECONDS'>,
): number {
  return (
    (env.PAYMENT_PLAN_CHANGE_WINDOW_SECONDS ?? DEFAULT_PAYMENT_PLAN_CHANGE_WINDOW_SECONDS) * 1000
  );
}
