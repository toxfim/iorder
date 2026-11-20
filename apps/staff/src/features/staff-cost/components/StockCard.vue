<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StockOverviewItem } from '@iorder/shared/staff-cost';
import { useFormat } from '@core/i18n/use-format';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useCostFormat } from '../composables/use-cost-format';
import { stockLevel } from '../domain/decimal';

// Qoldiq card "B · Rasm birinchi" (approved 2026-11-18): the photo first with the price status
// at the top left and the free stock at the top right, then code · category, the name on two
// lines, the selling price and "Jami · Band". The whole card is one button: it opens the side
// panel, where the actions are (a card cannot hold a second button).
const props = defineProps<{
  item: StockOverviewItem;
  name: string;
  /** The formatted USD selling price; null = not in the published list. */
  price: string | null;
}>();
const emit = defineEmits<{ open: [] }>();

const { t } = useI18n();
const { formatQuantity } = useCostFormat();
const { formatUnit } = useFormat();

const level = computed(() => stockLevel(props.item.availableQuantity));
const photo = computed(() => props.item.imageLargeUrl ?? props.item.imageUrl);
const stockText = computed(() => {
  const quantity = props.item.availableQuantity;
  if (quantity === null) return null;
  return level.value === 'out'
    ? t('staffCost.stockLevel.out')
    : `${formatQuantity(quantity)} ${formatUnit(props.item.unit)}`;
});
const label = computed(() =>
  [props.item.productCode, props.name, stockText.value ?? t('staffCost.stockLevel.unknown')].join(
    ', ',
  ),
);
</script>

<template>
  <button
    type="button"
    class="scard"
    :class="{ 'scard--muted': !item.isActive }"
    :aria-label="`${label}: ${t('staffCost.stock.openPanel')}`"
    @click="emit('open')"
  >
    <span class="scard__img">
      <img v-if="photo" :src="photo" alt="" loading="lazy" />
      <StaffIcon v-else name="package" :size="40" class="scard__noimg" />
      <span
        class="scard__pill scard__status"
        :class="item.isPriced ? 'scard__status--on' : 'scard__status--off'"
        >{{ item.isPriced ? t('staffCost.stock.pricedYes') : t('staffCost.stock.pricedNo') }}</span
      >
      <span
        v-if="stockText !== null"
        class="scard__pill scard__stock"
        :class="`scard__stock--${level}`"
        >{{ stockText
        }}<span v-if="level === 'low'" class="sr-only">
          · {{ t('staffCost.stockLevel.low') }}</span
        ></span
      >
    </span>
    <span class="scard__body">
      <span class="scard__meta"
        ><span class="mono">{{ item.productCode }}</span
        ><template v-if="item.category !== null"> · {{ item.category }}</template></span
      >
      <span class="scard__name">{{ name }}</span>
      <span class="scard__foot">
        <b class="scard__price" :class="{ 'scard__price--none': price === null }">{{
          price ?? '—'
        }}</b>
        <span class="scard__qty num"
          >{{ t('staffCost.stock.total') }}
          {{ item.stockQuantity !== null ? formatQuantity(item.stockQuantity) : '—' }} ·
          {{ t('staffCost.stock.held') }} {{ formatQuantity(item.heldQuantity) }}</span
        >
      </span>
    </span>
  </button>
</template>

<style scoped>
.scard {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.scard:hover {
  border-color: var(--d9);
  box-shadow: var(--sh-dropdown);
}

.scard:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* An inactive product: a dashed edge and a grey name (no opacity: tokens keep the contrast). */
.scard--muted {
  border-style: dashed;
}

.scard--muted .scard__name {
  color: var(--t2);
}

.scard__img {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 190px;
  padding: 16px;
  border-bottom: 1px solid var(--ef);
  background: var(--f5);
}

.scard__img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.scard__noimg {
  color: var(--t3);
}

.scard__pill {
  position: absolute;
  top: 10px;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-meta);
  font-weight: 500;
  white-space: nowrap;
}

.scard__status {
  left: 10px;
}

.scard__status--on {
  background: var(--green-bg);
  color: var(--green);
}

.scard__status--off {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.scard__stock {
  right: 10px;
  height: 26px;
  font-size: var(--fs-small);
  font-weight: 600;
}

.scard__stock--ok {
  background: var(--green-bg);
  color: var(--green);
}

.scard__stock--low {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.scard__stock--out {
  background: var(--red-bg);
  color: var(--red);
}

.scard__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 14px;
}

.scard__meta {
  overflow: hidden;
  font-size: var(--fs-meta);
  color: var(--t2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}

.scard__name {
  display: -webkit-box;
  min-height: 2.6em;
  overflow: hidden;
  font-weight: 600;
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.scard__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 6px;
}

.scard__price {
  font-size: var(--fs-section);
  font-variant-numeric: tabular-nums;
}

.scard__price--none {
  color: var(--t3);
}

.scard__qty {
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* Tablet: three columns with a shorter photo. */
@media (max-width: 1023px) {
  .scard__img {
    height: 150px;
    padding: 12px;
  }
}

/* Phone: two columns; the green "Narxlarda" leaves (no room), "Narx qo'yilmagan" moves down. */
@media (max-width: 639px) {
  .scard__img {
    height: 128px;
    padding: 10px;
  }

  .scard__status--on {
    display: none;
  }

  .scard__status--off {
    top: auto;
    bottom: 8px;
    left: 8px;
  }

  .scard__body {
    gap: 6px;
    padding: 10px 10px 12px;
  }

  .scard__price {
    font-size: var(--fs-body-lg);
  }
}
</style>
