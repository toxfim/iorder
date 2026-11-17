import { useI18n } from 'vue-i18n';
import type { Clock } from '@core/lib/business-clock';
import { ageMessage } from '../domain/dashboard-summary-presentation';
import { isActiveOrder, type OrderSummary } from '../domain/order-model';
import { orderAgeMinutes } from '../domain/order-sort';

/**
 * "Order age" of an order that is still moving through the pipeline: how long ago it was SUBMITTED
 * (the only instant the list contract carries; not the time in the current status, which is what
 * the dashboard's server-side `oldestWaitingSince` measures). An order that is finished or closed,
 * or whose instant is invalid or in the future, gets an empty text instead of a meaningless number.
 */
export function useOrderAge(clock: Clock): {
  ageText: (order: OrderSummary) => string;
  ageMinutes: (order: OrderSummary) => number;
} {
  const { t } = useI18n();

  /** -1 when there is no age to show. */
  function ageMinutes(order: OrderSummary): number {
    if (!isActiveOrder(order)) return -1;
    return orderAgeMinutes(order.submittedAt, clock.now()) ?? -1;
  }

  function ageText(order: OrderSummary): string {
    const minutes = ageMinutes(order);
    if (minutes < 0) return '';
    const { key, params } = ageMessage(minutes);
    return t(`orders.summary.age.${key}`, params);
  }

  return { ageText, ageMinutes };
}
