<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import type { DropdownOption } from '@/components/ui/AppDropdown.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import ApproveOrderDialog from './ApproveOrderDialog.vue';
import NewOrderCustomerDialog from './NewOrderCustomerDialog.vue';
import { useNewOrderDraft } from '../composables/new-order-draft';
import OrdersFilterBar from './OrdersFilterBar.vue';
import OrdersList from './OrdersList.vue';
import OrdersStatusTabs from './OrdersStatusTabs.vue';
import { rememberedListQuery } from '../composables/orders-list-memory';
import { useAllocationPlan } from '../composables/use-allocation-plan';
import { useOrderActions } from '../composables/use-order-actions';
import { usePagedOrders } from '../composables/use-paged-orders';
import type { PlanChoice } from '../domain/allocation-plan';
import {
  hasOrderFilters,
  NO_ORDER_FILTERS,
  orderFiltersToQuery,
  orderListRequest,
  ownStageFor,
  parseOrderFilters,
  secondaryFilterCount,
  stageTabCounts,
  type OrderFilters,
  type StageFilter,
} from '../domain/order-filters';
import {
  type FullOrderDetail,
  type FullOrderSummary,
  type PaymentMethod,
} from '../domain/order-model';

// «Buyurtmalar» (approved design 2026-11-20, 1440 / 768 / 390): search, "Filtrlar" with an inline
// row of lists, the status pills, then a table (cards on a phone). A SUBMITTED row offers the
// manager a quick "Tasdiqlash": it opens the approval dialog, which still asks for the supply plan
// and the sale type (Savdo turi) and offers the accounting skip, exactly as the order page does.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { ordersApi, ordersStore, currentUser } = useServices();

// The roles that see money (the same set as the order actions' `seesMoney`). Only a UI hint: the
// server refuses the money filters to the others and sends them no money fields.
const MONEY_ROLES: readonly string[] = ['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'];
const seesMoney = computed(() =>
  (currentUser.user.value?.staffRoles ?? []).some((role) => MONEY_ROLES.includes(role)),
);
// A pasted link with a money filter (payment, plan, the debt period) opens the plain list for the
// warehouse or the driver instead of a refusal of the whole list.
const filters = computed(() => {
  const parsed = parseOrderFilters(route.query);
  if (seesMoney.value) return parsed;
  return {
    ...parsed,
    payment: null,
    plan: null,
    period: parsed.period === 'debt' ? null : parsed.period,
  };
});
// The order page links back with these filters.
watch(filters, (value) => (rememberedListQuery.value = orderFiltersToQuery(value)), {
  immediate: true,
});
// The server filters and pages (newest first); the counts over the same filters give the tabs.
const request = computed(() => orderListRequest(filters.value));
const paged = usePagedOrders(ordersApi, () => request.value, { changes: ordersStore.revision });
const list = paged.orders;
const listEnd = ref<HTMLElement | null>(null);
useInfiniteScroll(listEnd, () => paged.loadMore());

// The filters live in the URL, so a quick filter in the sidebar, a link from the home page, a
// reload and the browser's back button from an order all land on the same list.
function setFilters(next: OrderFilters): void {
  void router.replace({ query: orderFiltersToQuery(next) });
}

// The text box types freely; the URL (and so the list) follows after a short pause, written with
// replace so Back leaves the page instead of stepping through every letter.
const SEARCH_PAUSE_MS = 300;
const search = ref(filters.value.text ?? '');
let pause: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(pause);
  pause = setTimeout(() => {
    const text = value.trim() === '' ? null : value.trim();
    if (text !== filters.value.text) setFilters({ ...filters.value, text });
  }, SEARCH_PAUSE_MS);
});
// A change that did not come from typing (the clear button, a link) is shown in the box.
watch(
  () => filters.value.text,
  (text) => {
    if ((text ?? '') !== search.value.trim()) search.value = text ?? '';
  },
);
onBeforeUnmount(() => clearTimeout(pause));

const stageValue = computed(() => filters.value.stage ?? 'all');
const ownStage = computed(() => ownStageFor(currentUser.user.value?.staffRoles ?? []));
const tabCounts = computed(() => stageTabCounts(paged.counts.value, request.value.countable));

// On a phone only three pills fit on one row (the design's 390 screen): the other statuses move
// into "Filtrlar → Holat". The tablet keeps every pill in one row that scrolls sideways.
const wide = useMediaQuery('(min-width: 600px)', true);
const COMPACT_TABS = 3;
const stageLabel = (value: StageFilter | 'all'): string =>
  value === 'all'
    ? t('orders.filters.all')
    : value === 'CLOSED'
      ? t('orders.filters.closed')
      : t(`orders.stages.${value}`);
const stageOptions = computed<DropdownOption[] | null>(() =>
  wide.value
    ? null
    : tabCounts.value.map((tab) => ({
        value: tab.value,
        label: stageLabel(tab.value),
        count: tab.count,
      })),
);

const pickStage = (value: string): void =>
  setFilters({ ...filters.value, stage: value === 'all' ? null : (value as StageFilter) });

// Payment and period sit in the row under "Filtrlar"; the button shows how many are on. A link
// that arrives with one of them set opens the row, so the filter in force is visible.
const secondaryCount = computed(() => secondaryFilterCount(filters.value));
// On a narrow screen a status without its own pill is shown in the open "Holat" list.
const stageHidden = computed(() => {
  if (wide.value || filters.value.stage === null) return false;
  const own = ownStage.value;
  const shown = ['all', ...(own ? [own] : [])].concat(
    tabCounts.value.map((tab) => tab.value).filter((v) => v !== 'all' && v !== own),
  );
  return !shown.slice(0, COMPACT_TABS).includes(filters.value.stage);
});
const filtersOpen = ref(secondaryCount.value > 0 || stageHidden.value);
watch([secondaryCount, stageHidden], ([count, hidden]) => {
  if (count > 0 || hidden) filtersOpen.value = true;
});

// By role, not by the rows: a filtered list that came back empty still shows the filters that
// emptied it, so each can be changed on its own.
const hasMoney = seesMoney;
const pageState = computed(() => (paged.state.value === 'empty' ? 'ready' : paged.state.value));

// --- the quick approval of a SUBMITTED row (the manager's step, lifecycle §3) ------------------

let stockRefused = false;
const approvalPlan = useAllocationPlan();
const actions = useOrderActions({
  // A refusal over stock keeps the dialog open with the fresh plan: one click from approved.
  onAllocationConflict: (caught) => {
    stockRefused = approvalPlan.absorbConflict(caught);
    return stockRefused;
  },
});
const canApprove = computed(() => actions.permissions().canDecide);
const approveOpen = ref(false);
// Kept after the dialog closes so its text does not blank out during the exit animation.
const approving = ref<FullOrderSummary | null>(null);
const approveBusy = ref(false);

function askApprove(order: FullOrderSummary): void {
  approving.value = order;
  approveOpen.value = true;
}

// --- the manager's new order on a customer's behalf [C, owner 2026-11-20] -----------------------

// Only the manager creates (a UI hint: the server refuses everybody else).
const canCreate = computed(() => (currentUser.user.value?.staffRoles ?? []).includes('MANAGER'));
const newOrder = useNewOrderDraft();
const newOpen = ref(false);

/** «+ Yangi buyurtma»: a fresh draft, step 1 over the list. */
function startNewOrder(): void {
  newOrder.reset();
  newOpen.value = true;
}

// "O'zgartirish" on the new order page comes back here with `?new=1`: step 1 again, the cart kept.
watch(
  () => route.query.new,
  (flag) => {
    if (flag === undefined) return;
    if (canCreate.value) newOpen.value = true;
    const { new: _flag, ...rest } = route.query;
    void _flag;
    void router.replace({ query: rest });
  },
  { immediate: true },
);

function customerChosen(customer: NewOrderCustomer, member: NewOrderCustomerMember): void {
  newOrder.choose(customer, member);
  newOpen.value = false;
  void router.push({ name: 'staff-new-order' });
}

async function confirmApprove(
  skipAccounting: boolean,
  paymentMethod: PaymentMethod,
  order: FullOrderDetail,
  plan: PlanChoice,
): Promise<void> {
  if (approveBusy.value) return;
  approveBusy.value = true;
  stockRefused = false;
  try {
    // The dialog read the order just now: its row version is the one the manager decided on.
    await actions.approve(order, paymentMethod, plan, skipAccounting);
    if (!stockRefused) approveOpen.value = false;
  } finally {
    approveBusy.value = false;
  }
}
</script>

<template>
  <StateView :state="pageState" @retry="paged.reload()">
    <div class="orders">
      <header class="head">
        <h1 class="head__title">{{ t('orders.page.title') }}</h1>
        <button
          v-if="canCreate"
          type="button"
          class="new"
          data-testid="new-order-open"
          @click="startNewOrder"
        >
          <StaffIcon name="plus" :size="16" />
          {{ t('orders.newOrder.open') }}
        </button>
      </header>

      <div class="toolbar">
        <SearchField
          v-model="search"
          class="search"
          label-hidden
          :placeholder="t('orders.filters.searchPlaceholder')"
        />
        <button
          type="button"
          class="fbtn"
          :class="{ 'fbtn--on': filtersOpen }"
          :aria-expanded="filtersOpen"
          :aria-label="
            secondaryCount > 0
              ? t('orders.filters.moreActive', { count: secondaryCount })
              : t('orders.filters.more')
          "
          data-testid="filters-toggle"
          @click="filtersOpen = !filtersOpen"
        >
          <StaffIcon name="filter" :size="16" />
          <span class="fbtn__label">{{ t('orders.filters.more') }}</span>
          <span v-if="secondaryCount > 0" class="fbtn__badge" aria-hidden="true">{{
            secondaryCount
          }}</span>
        </button>
        <OrdersStatusTabs
          class="tabs"
          :model-value="stageValue"
          :counts="tabCounts"
          :own-stage="ownStage"
          :limit="wide ? undefined : COMPACT_TABS"
          @update:model-value="pickStage"
        />
      </div>

      <OrdersFilterBar
        v-if="filtersOpen"
        :filters="filters"
        :show-money="hasMoney"
        :stages="stageOptions"
        @update:filters="setFilters"
        @clear="setFilters(NO_ORDER_FILTERS)"
      />

      <OrdersList
        :class="{ refreshing: paged.refreshing.value }"
        :aria-busy="paged.refreshing.value"
        :orders="list"
        :can-approve="canApprove"
        :empty-text="t('orders.page.empty')"
        @approve="askApprove"
      />

      <AppButton
        v-if="list.length === 0 && hasOrderFilters(filters)"
        variant="secondary"
        class="empty-clear"
        @click="setFilters(NO_ORDER_FILTERS)"
      >
        {{ t('orders.page.clear') }}
      </AppButton>
      <div v-if="paged.nextCursor.value !== null" ref="listEnd" class="more-rows">
        <p v-if="paged.moreError.value" class="more-rows__error" role="alert">
          {{ t('orders.page.moreFailed') }}
        </p>
        <AppButton variant="secondary" :loading="paged.loadingMore.value" @click="paged.loadMore()">
          {{ t('orders.page.loadMore') }}
        </AppButton>
      </div>
    </div>
    <NewOrderCustomerDialog
      v-if="canCreate"
      v-model="newOpen"
      :notice="newOrder.notice.value"
      :initial-customer="newOrder.customer.value"
      :initial-member="newOrder.member.value"
      @chosen="customerChosen"
    />
    <ApproveOrderDialog
      v-model="approveOpen"
      :order="approving"
      :busy="approveBusy"
      :plan="approvalPlan"
      @confirm="confirmApprove"
    />
  </StateView>
</template>

<style scoped>
/* Approved «Buyurtmalar» design: content up to 1240px, 16px between the blocks. */
.orders {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1240px;
  min-width: 0;
  animation: viewIn 0.35s var(--ease) both;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.new {
  display: inline-flex;
  flex: none;
  align-items: center;
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

.new:hover {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.new:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.head__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.search {
  flex: 0 1 380px;
  max-width: none;
}

.search :deep(.search__box) {
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  font-size: var(--fs-body-lg);
}

.fbtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-body-lg);
  font-weight: 500;
  cursor: pointer;
}

.fbtn:hover,
.fbtn--on {
  border-color: var(--d9);
  background: var(--hov);
}

.fbtn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.fbtn__badge {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--acc);
  color: var(--acc-on);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
}

/* The pills take a line of their own under the search and the button. */
.tabs {
  flex: 1 1 100%;
}

.empty-clear {
  align-self: center;
}

/* The rows of the previous filters while the new ones load. */
.refreshing {
  color: var(--t3);
  transition: color 0.15s var(--ease);
}

.more-rows {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.more-rows__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--red);
}

@media (pointer: coarse), (hover: none) {
  .fbtn {
    min-height: 44px;
  }
}

/* Phone: the search and an icon-only filter button share the first row. */
@media (max-width: 599px) {
  .search {
    flex: 1 1 0;
    min-width: 0;
  }

  .fbtn {
    position: relative;
    justify-content: center;
    width: 48px;
    padding: 0;
  }

  .fbtn__label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .fbtn__badge {
    position: absolute;
    top: -6px;
    right: -6px;
  }
}
</style>
