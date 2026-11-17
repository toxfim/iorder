<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AllocationPreviewItem } from '@iorder/shared/staff-orders';
import { useFormat } from '@core/i18n/use-format';
import type { AllocationPlan } from '../composables/use-allocation-plan';
import { checkItem, modeOf } from '../domain/allocation-plan';

// Which delivery lines an order holds: the FIFO proposal, the manager's own quantities, and what the
// server said about them. No cost and no supplier exist in this data. Mobile first: one column.
const props = defineProps<{ plan: AllocationPlan; disabled?: boolean; orderId: string }>();

const { t } = useI18n();
const { formatNumber, formatDateTime } = useFormat();
const open = ref(false);
const groupId = useId();

const preview = computed(() => props.plan.preview.value);
const isOwn = computed(() =>
  preview.value ? modeOf(preview.value, props.plan.draft.value) === 'MANUAL' : false,
);

const quantityOf = (item: AllocationPreviewItem, lineId: string): string =>
  props.plan.draft.value[item.orderItemId]?.[lineId] ?? '';

/** The rows of the draft with their refs, as the closed view shows them. */
function chosenRows(item: AllocationPreviewItem): { ref: string; quantity: string }[] {
  return item.lines.flatMap((line) => {
    const quantity = quantityOf(item, line.supplyLineId);
    return quantity === '' || quantity === '0' ? [] : [{ ref: line.deliveryRef, quantity }];
  });
}

const CHECK_KEYS = {
  TOO_LITTLE: 'orders.allocation.check.tooLittle',
  TOO_MUCH: 'orders.allocation.check.tooMuch',
  OVER_LINE: 'orders.allocation.check.overLine',
  NOT_A_NUMBER: 'orders.allocation.check.notANumber',
} as const;

function checkText(item: AllocationPreviewItem): string | null {
  const check = checkItem(item, props.plan.draft.value);
  return check === 'OK' ? null : t(CHECK_KEYS[check], { quantity: formatNumber(item.quantity) });
}
</script>

<template>
  <section class="plan" :aria-labelledby="`${groupId}-title`" data-testid="allocation-plan">
    <div class="plan__head">
      <h3 :id="`${groupId}-title`" class="plan__title">{{ t('orders.allocation.title') }}</h3>
      <span v-if="plan.state.value === 'ready'" class="plan__mode" data-testid="allocation-mode">{{
        t(isOwn ? 'orders.allocation.modeManual' : 'orders.allocation.modeFifo')
      }}</span>
    </div>

    <p v-if="plan.state.value === 'loading'" class="plan__status" role="status">
      {{ t('state.loading') }}
    </p>
    <p v-else-if="plan.state.value === 'denied'" class="plan__status" role="alert">
      {{ t('apiErrors.denied') }}
    </p>
    <p v-else-if="plan.state.value === 'closed'" class="plan__status" role="status">
      {{ t('apiErrors.allocationNotChangeable') }}
    </p>
    <p
      v-else-if="plan.state.value === 'error'"
      class="plan__status plan__status--error"
      role="alert"
    >
      {{ t('orders.allocation.loadError') }}
      <button type="button" class="plan__link" @click="plan.load(orderId)">
        {{ t('state.retry') }}
      </button>
    </p>

    <template v-else-if="preview">
      <p
        v-if="plan.notice.value === 'CHANGED'"
        class="plan__notice"
        role="alert"
        data-testid="allocation-changed"
      >
        {{ t('orders.allocation.changed') }}
      </p>
      <p
        v-if="!preview.feasible"
        class="plan__notice plan__notice--bad"
        role="alert"
        data-testid="allocation-short"
      >
        {{ t('orders.allocation.insufficient') }}
      </p>

      <ul class="plan__items">
        <li v-for="item in preview.items" :key="item.orderItemId" class="item">
          <div class="item__head">
            <span class="item__name">{{ item.name }}</span>
            <span class="item__qty num">{{ `× ${formatNumber(item.quantity)}` }}</span>
          </div>
          <!-- A staff-added product (no sheet «Товар_ID») has no supply to plan from: no lines,
               no shortage, nothing to choose. -->
          <p
            v-if="!item.stockTracked"
            class="item__earlier"
            :title="t('orders.supplies.untrackedHint')"
            data-testid="allocation-untracked"
          >
            {{ t('orders.supplies.untracked') }}
          </p>
          <template v-else>
            <p v-if="item.shortQuantity !== '0.000'" class="item__short" role="status">
              {{ t('orders.allocation.short', { quantity: formatNumber(item.shortQuantity) }) }}
            </p>
            <p v-if="item.earlierDemand.orders > 0" class="item__earlier">
              {{
                t(
                  'orders.allocation.earlier',
                  {
                    orders: item.earlierDemand.orders,
                    quantity: formatNumber(item.earlierDemand.quantity),
                  },
                  item.earlierDemand.orders,
                )
              }}
            </p>
            <ul v-if="!open" class="rows">
              <li v-for="row in chosenRows(item)" :key="row.ref" class="rows__row">
                <span class="mono rows__ref">{{ row.ref }}</span>
                <span class="num">{{ formatNumber(row.quantity) }}</span>
              </li>
            </ul>
            <div v-else class="lines">
              <p v-if="item.lines.length === 0" class="item__earlier">
                {{ t('orders.allocation.noLines') }}
              </p>
              <label v-for="line in item.lines" :key="line.supplyLineId" class="line">
                <span class="line__info">
                  <span class="mono line__ref">{{ line.deliveryRef }}</span>
                  <span class="line__meta">
                    {{ formatDateTime(line.deliveredAt) }} ·
                    {{ t('orders.allocation.free', { quantity: formatNumber(line.freeQuantity) }) }}
                  </span>
                </span>
                <input
                  class="line__input num"
                  type="text"
                  :inputmode="item.quantity.endsWith('.000') ? 'numeric' : 'decimal'"
                  :disabled="disabled"
                  :aria-label="t('orders.allocation.quantityFor', { ref: line.deliveryRef })"
                  :value="quantityOf(item, line.supplyLineId)"
                  @input="
                    plan.setQuantity(
                      item.orderItemId,
                      line.supplyLineId,
                      ($event.target as HTMLInputElement).value,
                    )
                  "
                />
              </label>
            </div>
            <p v-if="preview.feasible && checkText(item)" class="item__short" role="alert">
              {{ checkText(item) }}
            </p>
          </template>
        </li>
      </ul>

      <div class="plan__foot">
        <button
          type="button"
          class="plan__link"
          :disabled="disabled"
          data-testid="allocation-toggle"
          @click="open = !open"
        >
          {{ t(open ? 'orders.allocation.hideLines' : 'orders.allocation.chooseLines') }}
        </button>
        <button
          v-if="isOwn"
          type="button"
          class="plan__link"
          :disabled="disabled"
          data-testid="allocation-use-fifo"
          @click="plan.useFifo()"
        >
          {{ t('orders.allocation.useFifo') }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.plan {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.plan__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.plan__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.plan__mode,
.plan__status {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.plan__status--error {
  color: var(--red);
}

.plan__notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  font-size: var(--fs-small);
  font-weight: 600;
}

.plan__notice--bad {
  background: var(--red-bg);
  box-shadow: inset 0 0 0 1px var(--red);
}

.plan__items,
.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan__items {
  overflow: hidden;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
}

.item + .item {
  border-top: 1px solid var(--e8);
}

.item__head,
.rows__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-small);
}

.item__name,
.rows__ref,
.line__ref {
  min-width: 0;
  overflow-wrap: anywhere;
}

.item__qty {
  flex: none;
  color: var(--t2);
}

.rows__row {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.item__short,
.item__earlier {
  margin: 0;
  font-size: var(--fs-meta);
}

.item__short {
  font-weight: 600;
  color: var(--red);
}

.item__earlier {
  color: var(--t2);
}

.mono {
  font-family: var(--font-mono);
}

.lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.line__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: var(--fs-meta);
}

.line__meta {
  color: var(--t2);
}

.line__input {
  flex: none;
  width: 72px;
  height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  /* 16px: a smaller input makes iOS zoom the page on focus. */
  font-size: 16px;
  text-align: end;
}

.line__input:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 1px;
}

.plan__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.plan__link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  cursor: pointer;
}

.plan__link:disabled {
  cursor: default;
  color: var(--t3);
}

.plan__link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .plan__link {
    min-height: 44px;
  }

  .line__input {
    height: 44px;
  }
}
</style>
