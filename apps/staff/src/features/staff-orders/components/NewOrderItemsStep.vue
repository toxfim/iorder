<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PriceTier } from '@iorder/shared';
import type {
  NewOrderCatalogItem,
  NewOrderCustomer,
  NewOrderCustomerMember,
} from '@iorder/shared/staff-orders';
import AppDropdown, { type DropdownOption } from '@/components/ui/AppDropdown.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import { useFormat } from '@core/i18n/use-format';
import {
  distinctOf,
  filterCatalog,
  lineTotalOf,
  pieceCount,
  pricedLines,
  stockWarning,
  totalOf,
  withQuantity,
  type Catalog,
  type NewOrderLine,
} from '../domain/new-order';
import NewOrderClientBox from './NewOrderClientBox.vue';
import NewOrderQty from './NewOrderQty.vue';

// Step 2 «Tovarlar» (approved design): search, category and brand over the organization's catalog
// (its price tier; products with no stock on the sheet are not offered), product cards with the
// free stock, and the cart. Asking for more than the free stock only warns («Omborda atigi N
// dona») [P]: the manager may go on, the allocation at approval settles it. From 1024px the cart
// stays open on the right; below it a bar above the bottom edge shows the total and «Keyingi».
const props = defineProps<{
  items: readonly NewOrderCatalogItem[];
  catalog: Catalog;
  lines: readonly NewOrderLine[];
  customer: NewOrderCustomer;
  member: NewOrderCustomerMember;
  tier: PriceTier;
}>();
const emit = defineEmits<{
  'update:lines': [lines: NewOrderLine[]];
  changeCustomer: [];
  next: [];
}>();

const { t } = useI18n();
const { formatMoneyWithCurrency } = useFormat();

const text = ref('');
const category = ref<string>('all');
const brand = ref<string>('all');

const options = (field: 'category' | 'brand'): DropdownOption[] => [
  { value: 'all', label: t('orders.newOrder.items.all') },
  ...distinctOf(props.items, field).map((value) => ({ value, label: value })),
];
const categoryOptions = computed(() => options('category'));
const brandOptions = computed(() => options('brand'));

const shown = computed(() =>
  filterCatalog(props.items, {
    text: text.value,
    category: category.value === 'all' ? null : category.value,
    brand: brand.value === 'all' ? null : brand.value,
  }),
);

const quantityOf = (productId: string): number =>
  props.lines.find((line) => line.productId === productId)?.quantity ?? 0;

function setQuantity(productId: string, quantity: number): void {
  emit('update:lines', withQuantity(props.lines, productId, quantity));
}

const cartLines = computed(() => pricedLines(props.lines, props.catalog));
const total = computed(() => totalOf(props.lines, props.catalog, null));
const pieces = computed(() => pieceCount(props.lines));
const empty = computed(() => cartLines.value.length === 0);

function next(): void {
  if (!empty.value) emit('next');
}
</script>

<template>
  <div class="items">
    <section class="catalog" :aria-label="t('orders.newOrder.steps.items')">
      <div class="filters">
        <label class="field">
          <StaffIcon name="search" :size="16" />
          <input
            v-model="text"
            type="search"
            autocomplete="off"
            maxlength="100"
            :aria-label="t('orders.newOrder.items.search')"
            :placeholder="t('orders.newOrder.items.search')"
            data-testid="new-order-product-search"
          />
        </label>
        <AppDropdown
          v-model="category"
          class="dd"
          :options="categoryOptions"
          :label="t('orders.newOrder.items.category')"
          min-width="200px"
        >
          <template #value="{ selected }">
            <span class="dd__value">
              <span class="dd__key">{{ t('orders.newOrder.items.category') }}</span>
              <b>{{ selected?.label }}</b>
            </span>
          </template>
        </AppDropdown>
        <AppDropdown
          v-model="brand"
          class="dd"
          :options="brandOptions"
          :label="t('orders.newOrder.items.brand')"
          min-width="170px"
        >
          <template #value="{ selected }">
            <span class="dd__value">
              <span class="dd__key">{{ t('orders.newOrder.items.brand') }}</span>
              <b>{{ selected?.label }}</b>
            </span>
          </template>
        </AppDropdown>
      </div>
      <p class="summary" data-testid="new-order-catalog-summary">
        {{
          t('orders.newOrder.items.summary', {
            count: shown.length,
            tier: t(`orders.newOrder.tiers.${tier}`),
          })
        }}
      </p>

      <p v-if="shown.length === 0" class="none" role="status">
        {{ t('orders.newOrder.items.empty') }}
      </p>
      <ul v-else class="grid">
        <li
          v-for="item in shown"
          :key="item.productId"
          class="pc"
          :class="{ 'pc--in': quantityOf(item.productId) > 0 }"
          data-testid="new-order-product"
        >
          <div class="pc__img">
            <ProductThumb
              :src="item.imageUrl"
              :large-src="item.imageLargeUrl"
              :alt="item.name"
              :size="88"
            />
            <span
              class="pc__stock"
              :class="{
                'pc__stock--low':
                  item.stock !== null && stockWarning(item, quantityOf(item.productId)) !== null,
                'pc__stock--none': item.stock === null,
              }"
              data-testid="new-order-stock"
            >
              {{
                item.stock === null
                  ? t('orders.newOrder.items.byOrder')
                  : t('orders.newOrder.items.stock', { count: item.stock })
              }}
            </span>
          </div>
          <div class="pc__body">
            <span class="pc__meta mono"
              >{{ item.productCode
              }}<template v-if="item.category"> · {{ item.category }}</template></span
            >
            <span class="pc__name">{{ item.name }}</span>
            <b class="pc__price">{{ formatMoneyWithCurrency(item.unitPrice) }}</b>
            <NewOrderQty
              v-if="quantityOf(item.productId) > 0"
              wide
              :quantity="quantityOf(item.productId)"
              :name="item.name"
              @update:quantity="setQuantity(item.productId, $event)"
            />
            <button
              v-else
              type="button"
              class="pc__add"
              :aria-label="t('orders.newOrder.items.addLabel', { name: item.name })"
              data-testid="new-order-add"
              @click="setQuantity(item.productId, 1)"
            >
              + {{ t('orders.newOrder.items.add') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <aside class="cart" :aria-label="t('orders.newOrder.items.cart')" data-testid="new-order-cart">
      <header class="cart__head">
        <b>{{ t('orders.newOrder.items.cart') }}</b>
        <span class="mono muted">{{
          t('orders.newOrder.items.cartCount', { count: pieces })
        }}</span>
      </header>
      <div class="cart__body">
        <NewOrderClientBox
          :customer="customer"
          :member="member"
          changeable
          @change="emit('changeCustomer')"
        />
        <p v-if="empty" class="none">{{ t('orders.newOrder.items.cartEmpty') }}</p>
        <div
          v-for="{ line, item } in cartLines"
          :key="line.productId"
          class="ci"
          data-testid="cart-line"
        >
          <div class="ci__top">
            <ProductThumb :src="item.imageUrl" :alt="item.name" :size="40" :zoomable="false" />
            <span class="ci__name">{{ item.name }}</span>
          </div>
          <p v-if="stockWarning(item, line.quantity) !== null" class="warn" role="status">
            <StaffIcon name="alert" :size="14" />
            {{ t('orders.newOrder.items.onlyN', { count: stockWarning(item, line.quantity) }) }}
          </p>
          <div class="ci__bot">
            <NewOrderQty
              :quantity="line.quantity"
              :name="item.name"
              @update:quantity="setQuantity(line.productId, $event)"
            />
            <button
              type="button"
              class="trash"
              :aria-label="t('orders.newOrder.items.remove', { name: item.name })"
              @click="setQuantity(line.productId, 0)"
            >
              <StaffIcon name="trash" :size="15" />
            </button>
            <b class="ci__sum mono">{{
              formatMoneyWithCurrency(lineTotalOf(item, line.quantity, null) ?? '0')
            }}</b>
          </div>
        </div>
      </div>
      <footer class="cart__foot">
        <div class="cart__total">
          <span>{{ t('orders.newOrder.items.total') }}</span>
          <b class="mono" data-testid="new-order-total">{{ formatMoneyWithCurrency(total) }}</b>
        </div>
        <button
          type="button"
          class="next"
          :disabled="empty"
          data-testid="new-order-items-next"
          @click="next"
        >
          {{ t('orders.newOrder.items.next') }}
          <StaffIcon name="arrow" :size="16" />
        </button>
      </footer>
    </aside>

    <!-- Tablet and phone: the cart is not drawn; the bar keeps the total and «Keyingi». -->
    <div class="bar" data-testid="new-order-mini-bar">
      <div class="bar__sum">
        <span class="lbl">{{ t('orders.newOrder.items.totalPieces', { count: pieces }) }}</span>
        <b class="mono">{{ formatMoneyWithCurrency(total) }}</b>
      </div>
      <button type="button" class="next bar__next" :disabled="empty" @click="next">
        {{ t('orders.newOrder.items.nextShort') }}
        <StaffIcon name="arrow" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.items {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 20px;
  align-items: start;
}

.catalog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.field {
  display: flex;
  flex: 0 1 150px;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--t3);
}

.field:focus-within {
  border-color: var(--acc);
  box-shadow: var(--ring-focus);
}

.field input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
  outline: none;
}

.dd__value {
  display: inline-flex;
  gap: 8px;
  font-size: var(--fs-body-lg);
}

.dd__key {
  color: var(--t3);
}

.summary {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t2);
}

.none {
  margin: 0;
  padding: 24px 8px;
  font-size: var(--fs-body);
  color: var(--t3);
  text-align: center;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pc {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--e8);
  border-radius: 12px;
  background: var(--w);
}

.pc--in {
  border-color: var(--acc);
  box-shadow: 0 0 0 1px var(--acc);
}

.pc__img {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  border-bottom: 1px solid var(--ef);
  background: var(--f5);
}

.pc__stock {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--green-bg);
  color: var(--green);
  font-size: var(--fs-small);
  font-weight: 500;
}

.pc__stock--low {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.pc__stock--none {
  background: var(--ef);
  color: var(--t2);
}

.pc__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  padding: 10px 10px 12px;
}

.pc__meta {
  overflow: hidden;
  font-size: var(--fs-meta);
  color: var(--t3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc__name {
  display: -webkit-box;
  min-height: 36px;
  overflow: hidden;
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.pc__price {
  margin-top: auto;
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
}

.pc__add {
  height: 36px;
  border: 1px solid var(--acc);
  border-radius: 8px;
  background: var(--acc);
  color: var(--acc-on);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: pointer;
}

.pc__add:hover {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.cart {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 32px);
  border: 1px solid var(--e8);
  border-radius: 16px;
  background: var(--w);
}

.cart__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--ef);
  font-size: var(--fs-section);
}

.cart__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 14px 18px 0;
  overflow-y: auto;
}

.ci {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ef);
}

.ci__top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.ci__name {
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.35;
}

.ci__bot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ci__sum {
  margin-left: auto;
  font-size: var(--fs-body);
}

.trash {
  display: inline-flex;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--red);
  cursor: pointer;
}

.warn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--red);
}

.cart__foot {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 18px;
  border-top: 1px solid var(--ef);
}

.cart__total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  color: var(--t2);
}

.cart__total b {
  color: var(--ink);
  font-size: 20px;
}

.next {
  display: inline-flex;
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

.bar {
  display: none;
}

.lbl {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t3);
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  color: var(--t3);
  font-size: var(--fs-body);
}

button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* Tablet and phone: no cart panel, the fixed bar at the bottom (the design's mini panel). */
@media (max-width: 1023px) {
  .items {
    grid-template-columns: minmax(0, 1fr);
    padding-bottom: 96px;
  }

  .cart {
    display: none;
  }

  .field {
    flex: 1 1 100%;
  }

  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .bar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: var(--z-action-bar);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px calc(12px + var(--safe-bottom, 0px));
    border-top: 1px solid var(--e8);
    background: var(--w);
  }

  .bar__sum {
    display: flex;
    flex-direction: column;
  }

  .bar__sum b {
    font-size: var(--fs-section);
  }

  .bar__next {
    flex: 0 1 55%;
    height: 48px;
  }
}

@media (max-width: 599px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filters :deep(.dd) {
    flex: 1 1 0;
    min-width: 0;
  }
}

@media (pointer: coarse), (hover: none) {
  .pc__add,
  .trash {
    min-height: 44px;
  }
}
</style>
