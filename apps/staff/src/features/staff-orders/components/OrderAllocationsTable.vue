<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OrderStatus } from '@iorder/shared';
import type { OrderItemAllocation } from '@iorder/shared/staff-orders';
import { useFormat } from '@core/i18n/use-format';
import StaffIcon from '@/components/ui/StaffIcon.vue';

/** Money only when the role's data has it: the warehouse's lines simply have none. */
export interface AllocationTableLine {
  id: string;
  productCode: string;
  name: string;
  unit: string;
  quantity: string;
  unitPrice?: string;
  lineTotal?: string;
  /** Absent for the driver, who picks from no supply. */
  allocations?: readonly OrderItemAllocation[];
  /** False: a staff-added product outside the plan (no supply, no party). Absent: tracked. */
  stockTracked?: boolean;
}

// The order's lines with how many pieces sit on which supply and party ([C] owner 2026-10-30). Rows
// that stack rather than a wide table: on a phone a sideways scroll would hide the very columns the
// accountant and the warehouse came for, so the same markup only changes its grid with the width.
const props = defineProps<{
  lines: readonly AllocationTableLine[];
  status: OrderStatus;
  /** The server's total; null for the warehouse and the driver. */
  total: string | null;
  note?: string | null;
}>();

const { t } = useI18n();
const { formatMoney, formatNumber, formatUnit } = useFormat();

// Nothing is held before the approval and on an order closed before it, so an empty list says
// nothing there. On any other order it means the order is older than the holds.
const NEVER_HELD: readonly OrderStatus[] = ['SUBMITTED', 'REJECTED', 'CANCELLED'];
const showsNotAllocated = computed(() => !NEVER_HELD.includes(props.status));
const currency = computed(() => t('common.currency'));
const pieces = (quantity: string, unit: string): string =>
  `${formatNumber(quantity)} ${formatUnit(unit)}`;
</script>

<template>
  <section class="table" :aria-label="t('orders.detail.sections.items')" data-testid="order-lines">
    <header class="table__head">
      <h2 class="table__title">{{ t('orders.detail.sections.items') }}</h2>
      <span v-if="note" class="table__note">
        <StaffIcon name="lock" :size="13" />
        {{ note }}
      </span>
    </header>

    <p v-if="lines.length === 0" class="table__empty" role="status">
      {{ t('orders.detail.items.empty') }}
    </p>
    <ul v-else class="lines">
      <li v-for="line in lines" :key="line.id" class="line">
        <div class="line__top">
          <div class="line__product">
            <span class="line__name">{{ line.name }}</span>
            <span class="line__code">
              {{ t('orders.supplies.productId') }}: <span class="mono">{{ line.productCode }}</span>
            </span>
          </div>
          <dl class="figures">
            <div class="figure">
              <dt>{{ t('orders.detail.items.quantity') }}</dt>
              <dd>{{ pieces(line.quantity, line.unit) }}</dd>
            </div>
            <div v-if="line.unitPrice !== undefined" class="figure">
              <dt>{{ t('orders.detail.items.price') }}</dt>
              <dd class="num">{{ formatMoney(line.unitPrice) }} {{ currency }}</dd>
            </div>
            <div v-if="line.lineTotal !== undefined" class="figure">
              <dt>{{ t('orders.supplies.lineTotal') }}</dt>
              <dd class="num figure__strong">{{ formatMoney(line.lineTotal) }} {{ currency }}</dd>
            </div>
          </dl>
        </div>

        <p
          v-if="line.stockTracked === false && line.allocations"
          class="line__none"
          :title="t('orders.supplies.untrackedHint')"
          data-testid="order-line-untracked"
        >
          {{ t('orders.supplies.untracked') }}
        </p>
        <ul v-else-if="line.allocations && line.allocations.length > 0" class="splits">
          <li
            v-for="allocation in line.allocations"
            :key="allocation.supplyRef"
            class="split"
            data-testid="order-line-supply"
          >
            <span class="split__part">
              <span class="split__label">{{ t('orders.supplies.supply') }}</span>
              <span class="mono split__value">{{ allocation.supplyRef }}</span>
            </span>
            <span class="split__part">
              <span class="split__label">{{ t('orders.supplies.party') }}</span>
              <span class="mono split__value">{{
                allocation.partyNumber ?? t('orders.supplies.noParty')
              }}</span>
            </span>
            <span class="split__part split__part--end">
              <span class="split__label">{{ t('orders.supplies.pieces') }}</span>
              <span class="split__value">{{ pieces(allocation.quantity, line.unit) }}</span>
            </span>
          </li>
        </ul>
        <p
          v-else-if="line.allocations && showsNotAllocated"
          class="line__none"
          data-testid="order-line-not-allocated"
        >
          {{ t('orders.supplies.notAllocated') }}
        </p>
      </li>
    </ul>

    <footer v-if="total !== null" class="table__foot">
      <span class="table__total-label">{{ t('orders.detail.items.total') }}</span>
      <b class="num table__total">{{ formatMoney(total) }} {{ currency }}</b>
    </footer>
  </section>
</template>

<style scoped>
.table {
  min-width: 0;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.table__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--e8);
}

.table__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.table__note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.table__empty {
  margin: 0;
  padding: 24px 20px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.lines,
.splits {
  margin: 0;
  padding: 0;
  list-style: none;
}

.line {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}

.line + .line {
  border-top: 1px solid var(--e8);
}

.line__top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 24px;
}

.line__product {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.line__name {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.line__code {
  font-size: var(--fs-meta);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.figures {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
}

.figure {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.figure dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.figure dd {
  margin: 0;
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.figure__strong {
  font-weight: 600;
}

.splits {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px 16px;
  padding: 8px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.split__part {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.split__part--end {
  align-items: flex-end;
  text-align: right;
}

.split__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.split__value {
  font-size: var(--fs-small);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.line__none {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-small);
  color: var(--t2);
}

.table__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
}

.table__total-label {
  font-size: var(--fs-small);
  color: var(--t2);
}

.table__total {
  font-size: var(--fs-body);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .table__head,
  .line,
  .table__foot {
    padding-right: 16px;
    padding-left: 16px;
  }

  .figures {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
