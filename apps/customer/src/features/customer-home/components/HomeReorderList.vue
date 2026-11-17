<script setup lang="ts">
import type { CustomerReorderItem } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import { useFormat } from '@core/i18n/use-format';
import { useHomeCart } from '../composables/use-home-cart';
import { daysSince } from '../domain/home-blocks';
import HomePrice from './HomePrice.vue';
import HomeProductPhoto from './HomeProductPhoto.vue';

// "Qayta olish vaqti keldi": products the shop received before, longest since the last receipt
// first. One tap puts the usual quantity (the last order's) in the cart, capped at the stock.
defineProps<{ items: readonly CustomerReorderItem[]; now: Date }>();

const { t } = useI18n();
const { formatNumber, formatUnit } = useFormat();
const home = useHomeCart();

function why(item: CustomerReorderItem, now: Date): string {
  const days = daysSince(item.lastReceivedAt, now);
  const when =
    days === 0
      ? t('customer.home.reorder.today')
      : t('customer.home.reorder.daysAgo', { count: days });
  return item.timesOrdered > 1
    ? `${when} · ${t('customer.home.reorder.times', { count: item.timesOrdered })}`
    : when;
}

const wanted = (item: CustomerReorderItem): number => Number(item.usualQuantity);
/** What the tap will add: the usual quantity, or the stock when that is lower. Out of stock keeps the usual figure (the control is off). */
const shownQuantity = (item: CustomerReorderItem): string => {
  const addable = home.addable(item, wanted(item));
  return formatNumber(String(addable === 0 ? wanted(item) : addable));
};
</script>

<template>
  <section class="reorder" aria-labelledby="home-reorder-title" data-testid="home-reorder">
    <header class="reorder__head">
      <h2 id="home-reorder-title" class="reorder__title">{{ t('customer.home.reorder.title') }}</h2>
      <span class="reorder__hint">{{ t('customer.home.reorder.hint') }}</span>
    </header>
    <ul class="reorder__list" role="list">
      <li
        v-for="item in items"
        :key="item.productId"
        class="row"
        :class="{ 'row--out': home.stockOf(item) === 0 }"
        data-testid="home-reorder-row"
      >
        <HomeProductPhoto class="row__photo" :src="item.imageUrl" />
        <div class="row__text">
          <span class="row__name">{{ item.name }}</span>
          <span class="row__why" data-testid="home-reorder-why">{{ why(item, now) }}</span>
          <span class="row__price">
            <HomePrice :amount="item.price" />
            <span v-if="home.stockOf(item) === 0" class="row__out">
              {{ t('customer.home.stock.out') }}
            </span>
          </span>
        </div>
        <RouterLink
          v-if="home.quantityOf(item) !== null"
          :to="{ name: 'customer-cart' }"
          class="row__in-cart"
          :aria-label="
            t('customer.home.reorder.inCartLabel', {
              name: item.name,
              count: formatNumber(home.quantityOf(item) ?? '0'),
              unit: formatUnit(item.unit),
            })
          "
          data-testid="home-reorder-in-cart"
        >
          <span aria-hidden="true">{{ '✓' }}</span>
          {{
            t('customer.home.reorder.inCart', {
              count: formatNumber(home.quantityOf(item) ?? '0'),
              unit: formatUnit(item.unit),
            })
          }}
        </RouterLink>
        <AppButton
          v-else
          variant="dark"
          size="md"
          class="row__add"
          :soft-disabled="home.stockOf(item) === 0"
          :loading="home.isPending(item)"
          :aria-label="
            t('customer.home.reorder.addLabel', {
              name: item.name,
              count: shownQuantity(item),
              unit: formatUnit(item.unit),
            })
          "
          data-testid="home-reorder-add"
          @click="home.add(item, wanted(item))"
        >
          {{
            t('customer.home.reorder.add', {
              count: shownQuantity(item),
              unit: formatUnit(item.unit),
            })
          }}
        </AppButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.reorder {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.reorder__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.reorder__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}
.reorder__hint {
  flex: none;
  font-size: var(--fs-group);
  color: var(--t3);
}
.reorder__list {
  margin: 0;
  padding: 0 14px;
  list-style: none;
  border-radius: var(--r-panel);
  background: var(--w);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--f5);
}
.row:last-child {
  border-bottom: 0;
}
.row__photo {
  flex: none;
  width: 48px;
}
.row__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row__name {
  font-size: var(--fs-small);
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.row__why,
.row__price {
  font-size: var(--fs-group);
  color: var(--t3);
}
.row__price {
  display: flex;
  gap: 6px;
  font-weight: 600;
  color: var(--ink);
}
.row__out {
  font-weight: 600;
  color: var(--t2);
}
.row--out .row__name,
.row--out .row__price {
  color: var(--t3);
}
.row__add {
  flex: none;
  min-height: var(--tap-min);
  white-space: nowrap;
}
.row__in-cart {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-height: var(--tap-min);
  padding: 0 12px;
  border-radius: var(--r-btn-sm);
  background: var(--green-bg);
  color: var(--green);
  font-size: var(--fs-meta);
  font-weight: 600;
  white-space: nowrap;
}

@media (min-width: 640px) {
  .reorder {
    gap: 2px;
    padding: 18px 18px 8px;
    border-radius: var(--r-card);
    background: var(--w);
  }
  .reorder__head {
    padding-bottom: 6px;
  }
  .reorder__list {
    padding: 0;
    border-radius: 0;
  }
  .row {
    gap: 12px;
    border-top: 1px solid var(--f5);
    border-bottom: 0;
  }
  .row__photo {
    width: 56px;
    border: 1px solid var(--f5);
  }
  .row__name {
    white-space: normal;
  }
}
</style>
