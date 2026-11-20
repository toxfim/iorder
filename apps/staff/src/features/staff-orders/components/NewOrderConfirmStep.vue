<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PaymentPlan } from '@iorder/shared';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useFormat } from '@core/i18n/use-format';
import {
  lineTotalOf,
  pricedLines,
  totalOf,
  unitPriceOf,
  type Catalog,
  type NewOrderLine,
} from '../domain/new-order';
import NewOrderClientBox from './NewOrderClientBox.vue';

// Step 4 «Tasdiqlash» (approved design): read only. «Buyurtmani yaratish» creates the order in
// SUBMITTED ("Yangi"); the server prices it again from the same list and refuses a total that
// moved, so what is shown here is what is stored.
const props = defineProps<{
  catalog: Catalog;
  lines: readonly NewOrderLine[];
  plan: PaymentPlan;
  comment: string;
  customer: NewOrderCustomer;
  member: NewOrderCustomerMember;
  busy: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ create: []; back: [] }>();

const { t } = useI18n();
const { formatMoneyWithCurrency, formatNumber } = useFormat();
const rows = computed(() => pricedLines(props.lines, props.catalog));
const total = computed(() => totalOf(props.lines, props.catalog, props.plan));
</script>

<template>
  <div class="confirm">
    <section class="panel" :aria-label="t('orders.newOrder.steps.confirm')">
      <NewOrderClientBox :customer="customer" :member="member" plain />
      <div class="rows">
        <div
          v-for="{ line, item } in rows"
          :key="line.productId"
          class="row"
          data-testid="confirm-line"
        >
          <span class="row__name">{{ item.name }}</span>
          <span class="row__price mono muted">{{
            formatMoneyWithCurrency(unitPriceOf(item, plan) ?? item.unitPrice)
          }}</span>
          <span class="row__qty mono">{{ '×' }} {{ formatNumber(String(line.quantity)) }}</span>
          <b class="row__sum mono">{{
            formatMoneyWithCurrency(lineTotalOf(item, line.quantity, plan) ?? '0')
          }}</b>
        </div>
      </div>
      <div class="total">
        <span>{{ t('orders.newOrder.details.orderTotal') }}</span>
        <b class="mono" data-testid="new-order-confirm-total">{{
          formatMoneyWithCurrency(total)
        }}</b>
      </div>
    </section>

    <aside class="panel side">
      <span class="lbl">{{ t('orders.newOrder.confirm.plan') }}</span>
      <b class="plan" data-testid="new-order-confirm-plan">{{ t(`orders.paymentPlan.${plan}`) }}</b>
      <template v-if="comment.trim() !== ''">
        <span class="lbl">{{ t('orders.newOrder.confirm.comment') }}</span>
        <p class="comment">{{ comment.trim() }}</p>
      </template>
      <p v-if="error" class="err" role="alert">
        <StaffIcon name="alert" :size="14" />
        {{ error }}
      </p>
      <div class="acts">
        <button
          type="button"
          class="create"
          :disabled="busy"
          :aria-busy="busy"
          data-testid="new-order-create"
          @click="emit('create')"
        >
          <StaffIcon name="check" :size="16" />
          {{ t('orders.newOrder.confirm.create') }}
        </button>
        <button type="button" class="back" :disabled="busy" @click="emit('back')">
          <StaffIcon name="arrow" :size="14" class="flip" />
          {{ t('orders.newOrder.confirm.back') }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.confirm {
  display: grid;
  grid-template-columns: minmax(0, 720px) 360px;
  gap: 20px;
  align-items: start;
}

.panel {
  display: flex;
  flex-direction: column;
  padding: 20px 22px;
  border: 1px solid var(--e8);
  border-radius: 16px;
  background: var(--w);
}

.rows {
  margin-top: 16px;
  border-top: 1px solid var(--ef);
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px 60px 150px;
  gap: 16px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--ef);
}

.row__name {
  font-size: 15px;
  line-height: 1.35;
}

.row__price,
.row__sum {
  text-align: right;
}

.row__sum {
  font-size: var(--fs-section);
}

.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-top: 16px;
  color: var(--t2);
  font-size: var(--fs-section);
}

.total b {
  color: var(--ink);
  font-size: 22px;
}

.side {
  gap: 10px;
  padding: 18px;
}

.lbl {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t3);
}

.plan {
  font-size: var(--fs-section);
  font-weight: 600;
}

.comment {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--fs-body-lg);
}

.err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-body);
  color: var(--red);
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.create,
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  border-radius: 10px;
  font: inherit;
  font-size: var(--fs-body-lg);
  cursor: pointer;
}

.create {
  border: 1px solid var(--acc);
  background: var(--acc);
  color: var(--acc-on);
  font-weight: 600;
}

.create:hover:not(:disabled) {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.back {
  border: 1px solid var(--e8);
  background: var(--w);
  color: var(--ink);
  font-weight: 500;
}

.create:disabled,
.back:disabled {
  cursor: progress;
}

.flip {
  transform: scaleX(-1);
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  color: var(--t3);
}

button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

@media (max-width: 1023px) {
  .confirm {
    grid-template-columns: minmax(0, 1fr);
  }

  .create,
  .back {
    height: 52px;
  }
}

@media (max-width: 599px) {
  .panel {
    padding: 16px;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) auto auto;
    row-gap: 4px;
  }

  .row__name {
    grid-column: 1 / -1;
  }

  .row__price {
    text-align: left;
  }

  .row__price,
  .row__sum {
    font-size: var(--fs-body);
    white-space: nowrap;
  }

  .total b {
    font-size: 18px;
    white-space: nowrap;
  }
}
</style>
