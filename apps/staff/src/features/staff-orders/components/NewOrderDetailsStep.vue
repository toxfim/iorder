<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { PAYMENT_PLANS, type PaymentPlan } from '@iorder/shared';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useFormat } from '@core/i18n/use-format';
import {
  deferredPossible,
  lineTotalOf,
  pricedLines,
  totalOf,
  unitPriceOf,
  withQuantity,
  type Catalog,
  type NewOrderLine,
} from '../domain/new-order';
import NewOrderClientBox from './NewOrderClientBox.vue';
import NewOrderQty from './NewOrderQty.vue';

// Step 3 «Tafsilotlar» (approved design): the order's contents (quantities, removal, "+ Tovar
// qo'shish"), the customer, the payment plan («Bittada to'lash» / «Bo'lib to'lash», the confirmed
// names) and the optional comment. Nothing is preselected: «Keyingi» without a plan does not move,
// it scrolls to the plan block, rings it and says why (the design's «…4bTolovXato»). DEFERRED needs
// a deferred price on every line; the server refuses it too.
const props = defineProps<{
  catalog: Catalog;
  lines: readonly NewOrderLine[];
  plan: PaymentPlan | null;
  comment: string;
  customer: NewOrderCustomer;
  member: NewOrderCustomerMember;
  /** Open with the plan error (the page came back here because the plan became impossible). */
  planErrorShown?: boolean;
}>();
const emit = defineEmits<{
  'update:lines': [lines: NewOrderLine[]];
  'update:plan': [plan: PaymentPlan];
  'update:comment': [comment: string];
  changeCustomer: [];
  addItems: [];
  back: [];
  next: [];
}>();

const { t } = useI18n();
const { formatMoneyWithCurrency } = useFormat();
const planId = useId();
const commentId = useId();
const planBlock = ref<HTMLElement | null>(null);
const planError = ref(props.planErrorShown === true);
const commentHintId = useId();

const rows = computed(() => pricedLines(props.lines, props.catalog));
const total = computed(() => totalOf(props.lines, props.catalog, props.plan));
const canDefer = computed(() => deferredPossible(props.lines, props.catalog));
const empty = computed(() => rows.value.length === 0);

// A plan chosen clears the error; a cart that lost its deferred prices drops DEFERRED.
watch(
  () => props.plan,
  (plan) => {
    if (plan !== null) planError.value = false;
  },
);

function setQuantity(productId: string, quantity: number): void {
  emit('update:lines', withQuantity(props.lines, productId, quantity));
}

function choose(plan: PaymentPlan): void {
  if (plan === 'DEFERRED' && !canDefer.value) return;
  emit('update:plan', plan);
}

async function next(): Promise<void> {
  if (empty.value) return;
  if (props.plan === null || (props.plan === 'DEFERRED' && !canDefer.value)) {
    planError.value = true;
    await nextTick();
    planBlock.value?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    planBlock.value?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
    return;
  }
  emit('next');
}
</script>

<template>
  <div class="details">
    <section class="panel" :aria-label="t('orders.newOrder.details.composition')">
      <h2 class="panel__title">{{ t('orders.newOrder.details.composition') }}</h2>
      <div
        v-for="{ line, item } in rows"
        :key="line.productId"
        class="row"
        data-testid="detail-line"
      >
        <span class="row__who">
          <span class="row__name">{{ item.name }}</span>
          <small class="mono muted">{{
            t('orders.newOrder.details.perPiece', {
              price: formatMoneyWithCurrency(unitPriceOf(item, plan) ?? item.unitPrice),
            })
          }}</small>
        </span>
        <NewOrderQty
          :quantity="line.quantity"
          :name="item.name"
          @update:quantity="setQuantity(line.productId, $event)"
        />
        <b class="row__sum mono">{{
          formatMoneyWithCurrency(lineTotalOf(item, line.quantity, plan) ?? '0')
        }}</b>
        <button
          type="button"
          class="trash"
          :aria-label="t('orders.newOrder.items.remove', { name: item.name })"
          @click="setQuantity(line.productId, 0)"
        >
          <StaffIcon name="trash" :size="15" />
        </button>
      </div>
      <p v-if="empty" class="muted none">{{ t('orders.newOrder.items.cartEmpty') }}</p>
      <div class="total">
        <span>{{ t('orders.newOrder.details.orderTotal') }}</span>
        <b class="mono" data-testid="new-order-details-total">{{
          formatMoneyWithCurrency(total)
        }}</b>
      </div>
      <button type="button" class="add" data-testid="new-order-add-items" @click="emit('addItems')">
        + {{ t('orders.newOrder.details.addItem') }}
      </button>
    </section>

    <aside class="panel side">
      <NewOrderClientBox
        :customer="customer"
        :member="member"
        changeable
        @change="emit('changeCustomer')"
      />
      <div
        ref="planBlock"
        class="plan"
        :class="{ 'plan--err': planError }"
        data-testid="new-order-plan"
      >
        <span :id="planId" class="lbl">{{ t('orders.newOrder.details.plan') }}</span>
        <div class="opts" role="radiogroup" :aria-labelledby="planId" :aria-invalid="planError">
          <button
            v-for="value in PAYMENT_PLANS"
            :key="value"
            type="button"
            role="radio"
            class="opt"
            :class="{ 'opt--on': plan === value }"
            :aria-checked="plan === value"
            :aria-disabled="value === 'DEFERRED' && !canDefer"
            :data-testid="`plan-${value}`"
            @click="choose(value)"
          >
            <span class="rad" aria-hidden="true" />
            <span>{{ t(`orders.paymentPlan.${value}`) }}</span>
          </button>
        </div>
        <p v-if="!canDefer" class="muted">{{ t('orders.newOrder.details.noDeferred') }}</p>
        <p v-if="planError" class="err" role="alert">
          <StaffIcon name="alert" :size="14" />
          {{ t('orders.newOrder.details.planError') }}
        </p>
      </div>
      <div class="comment">
        <label :for="commentId" class="lbl">{{ t('orders.newOrder.details.comment') }}</label>
        <input
          :id="commentId"
          class="input"
          type="text"
          maxlength="1000"
          :value="comment"
          :placeholder="t('orders.newOrder.details.commentPlaceholder')"
          :aria-describedby="commentHintId"
          data-testid="new-order-comment"
          @input="emit('update:comment', ($event.target as HTMLInputElement).value)"
        />
        <!-- Stored as the order's comment, which the customer reads too. -->
        <small :id="commentHintId" class="muted" data-testid="new-order-comment-hint">{{
          t('orders.newOrder.details.commentHint')
        }}</small>
      </div>
      <div class="acts">
        <button
          type="button"
          class="back"
          :aria-label="t('orders.newOrder.details.back')"
          @click="emit('back')"
        >
          <StaffIcon name="arrow" :size="16" class="flip" />
        </button>
        <button
          type="button"
          class="next"
          :disabled="empty"
          data-testid="new-order-details-next"
          @click="next"
        >
          {{ t('orders.newOrder.details.next') }}
          <StaffIcon name="arrow" :size="16" />
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.details {
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

.panel__title {
  margin: 0 0 4px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ef);
  font-size: var(--fs-section);
  font-weight: 600;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 140px 32px;
  gap: 16px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--ef);
}

.row__who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row__name {
  font-size: 15px;
  line-height: 1.35;
}

.row__sum {
  font-size: var(--fs-section);
  text-align: right;
}

.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0 14px;
  color: var(--t2);
  font-size: var(--fs-section);
}

.total b {
  color: var(--ink);
  font-size: 22px;
}

.add,
.back {
  align-self: flex-start;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--e8);
  border-radius: 9px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  cursor: pointer;
}

.side {
  gap: 16px;
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
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plan--err {
  padding: 10px;
  border: 1.5px solid var(--red);
  border-radius: 14px;
  background: var(--acc-bg2);
}

.opts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 50px;
  padding: 0 16px;
  border: 1px solid var(--e8);
  border-radius: 12px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-section);
  text-align: left;
  cursor: pointer;
}

.opt--on {
  border-color: var(--acc);
  background: var(--acc-bg);
}

.opt[aria-disabled='true'] {
  background: var(--f5);
  color: var(--b5);
  cursor: not-allowed;
}

.rad {
  flex: none;
  width: 20px;
  height: 20px;
  border: 2px solid var(--b5);
  border-radius: 50%;
}

.opt--on .rad {
  border: 6px solid var(--acc);
}

.err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--red);
}

.comment {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input {
  height: 44px;
  padding: 0 16px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
}

.input:focus {
  border-color: var(--acc);
  outline: none;
  box-shadow: var(--ring-focus);
}

.acts {
  display: flex;
  gap: 8px;
}

.back {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 44px;
  padding: 0;
}

.flip {
  transform: scaleX(-1);
}

.next {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 18px;
  border: 1px solid var(--acc);
  border-radius: 10px;
  background: var(--acc);
  color: var(--acc-on);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 600;
  cursor: pointer;
}

.next:hover:not(:disabled) {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.next:disabled {
  border-color: var(--e8);
  background: var(--ef);
  color: var(--b5);
  cursor: not-allowed;
}

.trash {
  display: inline-flex;
  justify-content: center;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--red);
  cursor: pointer;
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

.none {
  padding: 16px 0;
}

button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* Tablet and phone: one column, the actions in a bar fixed at the bottom. */
@media (max-width: 1023px) {
  .details {
    grid-template-columns: minmax(0, 1fr);
    padding-bottom: 96px;
  }

  .acts {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: var(--z-action-bar);
    padding: 12px 16px calc(12px + var(--safe-bottom, 0px));
    border-top: 1px solid var(--e8);
    background: var(--w);
  }

  .next {
    height: 52px;
  }

  .back {
    height: 52px;
  }
}

@media (max-width: 599px) {
  .panel {
    padding: 16px;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }

  .row__sum {
    text-align: left;
    white-space: nowrap;
  }

  .total b {
    font-size: 18px;
    white-space: nowrap;
  }
}

@media (pointer: coarse), (hover: none) {
  .add,
  .trash {
    min-height: 44px;
  }
}
</style>
