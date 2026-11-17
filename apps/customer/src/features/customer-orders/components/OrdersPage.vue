<script setup lang="ts">
import type { CustomerOrderGroup } from '@iorder/shared';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import { useCustomerServices } from '@/features/customer-app/services';
import { CUSTOMER_ORDER_STATES, stateKey, type CustomerOrderState } from '../domain/order-display';
import { useOrdersList } from '../composables/use-orders-list';
import OrderCard from './OrderCard.vue';

const { t } = useI18n();
const { ordersApi, goods } = useCustomerServices();
const list = useOrdersList(ordersApi);
// The next page loads on its own as the end of the list nears; the button stays as a fallback.
const listEnd = ref<HTMLElement | null>(null);
// After a failure only the button retries: retrying on every scroll would blink the error.
useInfiniteScroll(listEnd, () => (list.moreError.value ? false : list.loadMore()));
// Two ways to narrow the list, one at a time: what still needs something from someone ("Faol":
// on its way, or delivered and waiting for the receipt) against what is finished, or one of the
// three states. "Hammasi" clears both.
const groups = computed(() => [
  { value: null, label: t('customer.orders.filterAll') },
  { value: 'ACTIVE' as const, label: t('customer.presentation.active') },
  { value: 'COMPLETED' as const, label: t('customer.presentation.completed') },
]);
const groupIsOn = (value: CustomerOrderGroup | null): boolean =>
  list.filter.value === null && list.group.value === value;
function pickGroup(value: CustomerOrderGroup | null): void {
  list.filter.value = null;
  list.group.value = value;
}

const states = computed(() =>
  CUSTOMER_ORDER_STATES.map((value) => ({ value, label: t(stateKey(value)) })),
);
/** Pressing the state that is on turns the filter off again. */
function pickState(value: CustomerOrderState): void {
  list.group.value = null;
  list.filter.value = list.filter.value === value ? null : value;
}
const filtered = computed(
  () => list.filter.value !== null || list.group.value !== null || list.search.value.trim() !== '',
);
</script>

<template>
  <section class="orders">
    <header class="head">
      <div class="orders-title-row">
        <h1 class="head__title">{{ t('customer.orders.title') }}</h1>
        <RouterLink
          v-if="goods.summary.value?.hasProducts"
          class="goods-shortcut"
          :to="{ name: 'customer-goods' }"
          >{{ t('customer.goods.title') }} →</RouterLink
        >
      </div>
      <p class="head__meta">{{ t('customer.orders.subtitle') }}</p>
    </header>

    <SearchField
      v-model="list.search.value"
      :placeholder="t('customer.presentation.orderSearch')"
      :maxlength="40"
    />
    <div class="group-filters" role="group" :aria-label="t('customer.orders.filterLabel')">
      <button
        v-for="filter in groups"
        :key="filter.value ?? 'all'"
        type="button"
        :aria-pressed="groupIsOn(filter.value)"
        :class="{ selected: groupIsOn(filter.value) }"
        @click="pickGroup(filter.value)"
      >
        {{ filter.label }}
      </button>
    </div>
    <details class="status-filter" data-testid="state-filter">
      <summary>
        <span>
          {{ t('customer.orders.filterLabel')
          }}<template v-if="list.filter.value !== null"
            >:
            <strong data-testid="state-filter-current">{{
              t(stateKey(list.filter.value))
            }}</strong></template
          >
        </span>
      </summary>
      <div class="filters" role="group" :aria-label="t('customer.orders.filterLabel')">
        <button
          v-for="option in states"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ 'chip--on': list.filter.value === option.value }"
          :aria-pressed="list.filter.value === option.value"
          :data-testid="`state-filter-${option.value}`"
          @click="pickState(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </details>

    <StateView
      :state="list.state.value"
      :title="
        list.state.value === 'empty'
          ? t(!filtered ? 'customer.orders.empty.title' : 'customer.orders.emptyFiltered.title')
          : undefined
      "
      :description="
        list.state.value === 'empty'
          ? t(
              !filtered
                ? 'customer.orders.empty.description'
                : 'customer.orders.emptyFiltered.description',
            )
          : undefined
      "
      @retry="list.reload()"
    >
      <template v-if="list.state.value === 'empty' && !filtered" #actions>
        <RouterLink :to="{ name: 'customer-catalog' }" class="action-link">
          {{ t('customer.orders.empty.action') }}
        </RouterLink>
      </template>

      <div class="orders-table-head" aria-hidden="true">
        <span>{{ t('customer.goods.order') }}</span
        ><span>{{ t('customer.goods.orderedDate') }}</span
        ><span>{{ t('customer.goods.status') }}</span
        ><span>{{ t('customer.goods.product') }}</span
        ><span>{{ t('customer.order.total') }}</span
        ><span />
      </div>
      <ul class="list">
        <li v-for="order in list.orders.value" :key="order.id">
          <OrderCard :order="order" />
        </li>
      </ul>

      <p v-if="list.moreError.value" class="more-error" role="alert">
        {{ t('customer.orders.loadMoreFailed') }}
      </p>
      <div
        v-if="list.hasMore.value"
        ref="listEnd"
        class="list-end"
        :class="{
          'list-end--loading': list.loadingMore.value,
          'list-end--manual': list.moreError.value,
        }"
      >
        <AppButton
          variant="secondary"
          size="lg"
          block
          :loading="list.loadingMore.value"
          @click="list.loadMore()"
        >
          {{
            list.loadingMore.value
              ? t('customer.orders.loadingMore')
              : t('customer.orders.loadMore')
          }}
        </AppButton>
      </div>
    </StateView>
  </section>
</template>

<style scoped>
.orders-table-head {
  display: none;
}
@media (min-width: 960px) {
  .orders-table-head {
    display: grid;
    grid-template-columns:
      minmax(90px, 0.8fr) minmax(125px, 1fr) minmax(160px, 1.3fr) minmax(85px, 0.7fr)
      minmax(130px, 1.1fr) 20px;
    gap: var(--gap-card);
    padding: var(--goods-pad);
    border-radius: var(--r-card) var(--r-card) 0 0;
    background: var(--w);
    font-size: var(--fs-meta);
    color: var(--t3);
    margin-bottom: -12px;
  }
  .orders .list {
    gap: 0;
    background: var(--w);
    border-radius: 0 0 var(--r-card) var(--r-card);
    overflow: hidden;
  }
}

.orders-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-card);
}
.group-filters {
  display: flex;
  padding: 4px;
  gap: 4px;
  background: var(--ef);
  border-radius: var(--r-input);
}
.group-filters button {
  flex: 1;
  min-width: 0;
  min-height: var(--tap-min);
  padding: 6px;
  border: 0;
  border-radius: var(--r-btn-sm);
  font: inherit;
  font-size: var(--fs-meta);
  background: transparent;
  color: var(--t3);
  cursor: pointer;
}
.group-filters .selected {
  color: var(--ink);
  background: var(--w);
  font-weight: 600;
}
.status-filter {
  font-size: var(--fs-meta);
  color: var(--t3);
}
.status-filter summary {
  cursor: pointer;
  min-height: var(--tap-min);
  display: flex;
  align-items: center;
}
/* The filter that is on stays readable while the chips are folded away. */
.status-filter summary strong {
  color: var(--ink);
  font-weight: 600;
}
.orders {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.head__meta {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

/* Three states: they wrap on a narrow phone instead of hiding behind a sideways scroll. */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 2px;
}

.chip {
  flex: none;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 22px;
  background: var(--w);
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 500;
  cursor: pointer;
}

.chip--on {
  border-color: var(--ink);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Tablet and desktop: two cards per row instead of one stretched card. */
@media (min-width: 640px) {
  .list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
}

.more-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.action-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  border-radius: var(--r-btn-sm);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  font-size: var(--fs-body);
  font-weight: 600;
}
</style>
