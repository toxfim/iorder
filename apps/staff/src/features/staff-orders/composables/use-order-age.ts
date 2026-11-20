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
  agoText: (order: OrderSummary) => string;
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

  /**
   * The approved design's "12 daqiqa oldin" / "1 soat oldin" / "2 kun oldin" since the order was
   * placed, for every order (finished and closed ones too): one unit only, so it fits the list's
   * number column on one line. Empty only when the instant is invalid or in the future.
   */
  function agoText(order: OrderSummary): string {
    const minutes = orderAgeMinutes(order.submittedAt, clock.now());
    if (minutes === null) return '';
    if (minutes < 60) return t('orders.list.agoMinutes', { count: minutes }, minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('orders.list.agoHours', { count: hours }, hours);
    const days = Math.floor(hours / 24);
    return t('orders.list.agoDays', { count: days }, days);
  }

  return { ageText, ageMinutes, agoText };
}
