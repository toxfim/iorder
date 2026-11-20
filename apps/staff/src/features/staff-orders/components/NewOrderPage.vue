<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { PriceTier } from '@iorder/shared';
import type { NewOrderCatalogItem } from '@iorder/shared/staff-orders';
import { useServices } from '@/app/services';
import StateView from '@core/components/ui/StateView.vue';
import type { StateViewState } from '@core/components/ui/StateView.vue';
import { useToast } from '@core/composables/use-toast';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { useNewOrderDraft } from '../composables/new-order-draft';
import {
  afterRefusal,
  createRequestOf,
  deferredPossible,
  offeredInStep2,
  type Catalog,
  type NewOrderStep,
} from '../domain/new-order';
import NewOrderConfirmStep from './NewOrderConfirmStep.vue';
import NewOrderDetailsStep from './NewOrderDetailsStep.vue';
import NewOrderItemsStep from './NewOrderItemsStep.vue';
import NewOrderStepper from './NewOrderStepper.vue';

// Steps 2-4 of the manager's new order [C, owner 2026-11-20] (approved design «02-yangi-buyurtma»):
// products and cart, details (plan, comment), confirmation. Step 1 is the dialog over the orders
// list; without a chosen customer this page sends the manager back there. «Bekor qilish» drops the
// draft and creates nothing. The order is created only by «Buyurtmani yaratish».
const { t } = useI18n();
const router = useRouter();
const { ordersApi, ordersStore } = useServices();
const { showToast } = useToast();
const draft = useNewOrderDraft();

const step = ref<NewOrderStep>('items');
const state = ref<StateViewState>('loading');
const items = shallowRef<readonly NewOrderCatalogItem[]>([]);
const tier = ref<PriceTier>('STANDARD');
const catalog = computed<Catalog>(() => new Map(items.value.map((item) => [item.productId, item])));
const busy = ref(false);
const createError = ref<string | null>(null);
/** Step 3 opens with the plan error (a DEFERRED plan that a reload made impossible). */
const planErrorShown = ref(false);

const LIST = { name: 'staff-orders' } as const;

async function load(): Promise<void> {
  const customer = draft.customer.value;
  if (customer === null) return;
  state.value = 'loading';
  try {
    const answer = await ordersApi.getNewOrderCatalog(customer.organizationId);
    items.value = offeredInStep2(answer.items);
    tier.value = answer.priceTier;
    // A product step 2 does not offer (another customer's tier, gone, or no free stock left)
    // leaves the cart. Written only when something left: the same content keeps the order's key.
    const offered = new Set(items.value.map((item) => item.productId));
    const kept = draft.lines.value.filter((line) => offered.has(line.productId));
    if (kept.length !== draft.lines.value.length) draft.lines.value = kept;
    state.value = items.value.length === 0 ? 'empty' : 'ready';
  } catch (error) {
    state.value = error instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}

onMounted(() => {
  if (draft.customer.value === null || draft.member.value === null) {
    void router.replace({ ...LIST, query: { new: '1' } });
    return;
  }
  void load();
});
watch(
  () => draft.customer.value?.organizationId,
  () => void load(),
);

function cancel(): void {
  draft.reset();
  void router.push(LIST);
}

/** "O'zgartirish": back to step 1 over the list; the cart stays in the draft. */
function changeCustomer(): void {
  void router.push({ ...LIST, query: { new: '1' } });
}

async function create(): Promise<void> {
  const customer = draft.customer.value;
  const member = draft.member.value;
  const plan = draft.plan.value;
  if (busy.value || !customer || !member || !plan) return;
  busy.value = true;
  createError.value = null;
  try {
    const order = await ordersStore.create(
      createRequestOf({
        customer,
        member,
        lines: draft.lines.value,
        catalog: catalog.value,
        plan,
        comment: draft.comment.value,
      }),
      draft.idempotencyKey.value,
    );
    draft.reset();
    showToast({ message: t('orders.newOrder.confirm.created', { id: order.orderNumber }) });
    // The list's «Yangi» tab, where the new order now is.
    void router.push({ ...LIST, query: { stage: 'SUBMITTED' } });
  } catch (error) {
    const described = describePricingError('load', error);
    const message = t(described.key, described.params ?? {});
    const action = afterRefusal(error);
    if (action === 'CHOOSE_CUSTOMER') {
      // The customer is no longer possible: step 1 again, with the server's reason; the cart stays.
      draft.customer.value = null;
      draft.member.value = null;
      draft.notice.value = message;
      void router.push({ ...LIST, query: { new: '1' } });
      return;
    }
    createError.value = message;
    if (action === 'RELOAD_CATALOG') await reloadAfterRefusal();
  } finally {
    busy.value = false;
  }
}

/** The prices or the offer moved: the server's catalog again, and the step that needs a look. */
async function reloadAfterRefusal(): Promise<void> {
  await load();
  if (draft.lines.value.length === 0) {
    step.value = 'items';
    return;
  }
  if (draft.plan.value === 'DEFERRED' && !deferredPossible(draft.lines.value, catalog.value)) {
    planErrorShown.value = true;
    step.value = 'details';
  }
}

const stateTitle = computed(() =>
  state.value === 'denied' ? t('orders.newOrder.denied') : undefined,
);
</script>

<template>
  <div class="new-order" data-testid="new-order-page">
    <header class="head">
      <div class="head__text">
        <h1 class="head__title">{{ t('orders.newOrder.title') }}</h1>
        <NewOrderStepper :current="step" />
      </div>
      <button type="button" class="cancel" data-testid="new-order-cancel" @click="cancel">
        {{ t('orders.newOrder.cancel') }}
      </button>
    </header>

    <StateView :state="state" :title="stateTitle" @retry="load">
      <template v-if="draft.customer.value && draft.member.value">
        <NewOrderItemsStep
          v-if="step === 'items'"
          :items="items"
          :catalog="catalog"
          :lines="draft.lines.value"
          :customer="draft.customer.value"
          :member="draft.member.value"
          :tier="tier"
          @update:lines="draft.lines.value = $event"
          @change-customer="changeCustomer"
          @next="step = 'details'"
        />
        <NewOrderDetailsStep
          v-else-if="step === 'details'"
          :catalog="catalog"
          :lines="draft.lines.value"
          :plan="draft.plan.value"
          :comment="draft.comment.value"
          :customer="draft.customer.value"
          :member="draft.member.value"
          :plan-error-shown="planErrorShown"
          @update:lines="draft.lines.value = $event"
          @update:plan="draft.plan.value = $event"
          @update:comment="draft.comment.value = $event"
          @change-customer="changeCustomer"
          @add-items="step = 'items'"
          @back="step = 'items'"
          @next="step = 'confirm'"
        />
        <NewOrderConfirmStep
          v-else-if="draft.plan.value"
          :catalog="catalog"
          :lines="draft.lines.value"
          :plan="draft.plan.value"
          :comment="draft.comment.value"
          :customer="draft.customer.value"
          :member="draft.member.value"
          :busy="busy"
          :error="createError"
          @create="create"
          @back="step = 'details'"
        />
      </template>
    </StateView>
  </div>
</template>

<style scoped>
.new-order {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.head__text {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.cancel {
  flex: none;
  height: 44px;
  padding: 0 16px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 500;
  cursor: pointer;
}

.cancel:hover {
  background: var(--hov);
}

.cancel:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}
</style>
