<script setup lang="ts">
import type { CustomerTimelineEvent } from '@iorder/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import GoodsIcon from '@/features/customer-goods/components/GoodsIcon.vue';
import { useFormat } from '@core/i18n/use-format';
import { customerHistory, type HistoryEntry } from '../domain/order-display';

// The order history a customer reads, oldest first: accepted, what was changed in the order,
// delivered, receipt confirmed, or refused with the reason as written. Which events count is
// decided by `customerHistory`; this component only words them.
const props = defineProps<{ events: readonly CustomerTimelineEvent[]; orderedAt: string }>();
const { t } = useI18n();
const { formatDateTime, formatMoneyWithCurrency, formatNumber } = useFormat();

const history = computed(() => customerHistory(props.events, props.orderedAt));

/**
 * A person of the customer's own shop is named (the server sends a name only for them); a change
 * made by the company is the manager's. Nobody else is named.
 */
function who(entry: HistoryEntry): string | null {
  const actor = entry.event?.actor;
  if (!actor) return null;
  if (actor.name !== null) return actor.name;
  return actor.role === 'MANAGER' ? t('customer.order.history.byManager') : null;
}
</script>

<template>
  <ol class="goods-milestones history" data-testid="order-history">
    <li v-for="entry in history" :key="entry.id" :data-kind="entry.kind">
      <span class="milestone-mark" :class="{ 'history__mark--refused': entry.kind === 'REFUSED' }">
        <GoodsIcon :name="entry.kind === 'REFUSED' ? 'close' : 'check-neutral'" />
      </span>
      <div class="history__body">
        <p class="history__title">{{ t(`customer.order.history.${entry.kind}`) }}</p>
        <p class="history__meta">
          <time :datetime="entry.occurredAt">{{ formatDateTime(entry.occurredAt) }}</time>
          <template v-if="who(entry)"> · {{ who(entry) }}</template>
        </p>
        <template v-if="entry.event?.paymentPlanChange">
          <p class="history__line">
            {{
              t('customer.order.history.plan', {
                from: t(`customer.plan.${entry.event.paymentPlanChange.from}`),
                to: t(`customer.plan.${entry.event.paymentPlanChange.to}`),
              })
            }}
          </p>
          <p class="history__line">
            {{
              t('customer.order.history.total', {
                from: formatMoneyWithCurrency(entry.event.paymentPlanChange.oldTotal),
                to: formatMoneyWithCurrency(entry.event.paymentPlanChange.newTotal),
              })
            }}
          </p>
        </template>
        <template v-if="entry.event?.itemsChange">
          <ul class="history__changes">
            <li v-for="line in entry.event.itemsChange.lines" :key="line.productCode">
              {{
                line.newQuantity === null
                  ? t('customer.order.history.removed', {
                      name: line.name,
                      from: formatNumber(line.oldQuantity),
                    })
                  : t('customer.order.history.quantity', {
                      name: line.name,
                      from: formatNumber(line.oldQuantity),
                      to: formatNumber(line.newQuantity),
                    })
              }}
            </li>
          </ul>
          <p
            v-if="
              entry.event.itemsChange.oldTotal !== null && entry.event.itemsChange.newTotal !== null
            "
            class="history__line"
          >
            {{
              t('customer.order.history.total', {
                from: formatMoneyWithCurrency(entry.event.itemsChange.oldTotal),
                to: formatMoneyWithCurrency(entry.event.itemsChange.newTotal),
              })
            }}
          </p>
        </template>
        <p v-if="entry.event?.comment" class="history__reason">
          <strong>{{ t('customer.order.reason') }}:</strong> {{ entry.event.comment }}
        </p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.history__body {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
  min-width: 0;
}

.history p {
  margin: 0;
  overflow-wrap: anywhere;
}

.history__title {
  font-weight: 600;
}

.history__meta {
  font-size: var(--fs-meta);
  color: var(--t3);
}

.history__line,
.history__changes {
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.history__changes {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-wrap: anywhere;
}

.history__reason {
  font-size: var(--fs-small);
  color: var(--t2);
}

.history__reason strong {
  font-weight: 600;
}

.history__mark--refused {
  background: var(--red-bg);
}
</style>
