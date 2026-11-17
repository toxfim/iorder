<script setup lang="ts">
import type { CustomerMatchingItem } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import { useFormat } from '@core/i18n/use-format';
import QuantityStepper from '@/features/customer-cart/components/QuantityStepper.vue';
import { useHomeCart } from '../composables/use-home-cart';
import { stockBadgeOf } from '../domain/home-blocks';
import HomePrice from './HomePrice.vue';
import HomeProductPhoto from './HomeProductPhoto.vue';

// "Siz olgan tovarlarga mos": products of the categories the shop buys from, not bought yet. A
// row that scrolls sideways on a phone, a grid from the tablet up.
defineProps<{ items: readonly CustomerMatchingItem[] }>();

const { t } = useI18n();
const { formatNumber, formatUnit } = useFormat();
const home = useHomeCart();

function badge(item: CustomerMatchingItem): string | null {
  const stock = home.stockOf(item);
  switch (stockBadgeOf(stock)) {
    case 'out':
      return t('customer.home.stock.out');
    case 'low':
      return t('customer.home.stock.low', {
        count: formatNumber(String(stock)),
        unit: formatUnit(item.unit),
      });
    default:
      return null;
  }
}
</script>

<template>
  <section class="matching" aria-labelledby="home-matching-title" data-testid="home-matching">
    <header class="matching__head">
      <h2 id="home-matching-title" class="matching__title">
        {{ t('customer.home.matching.title') }}
      </h2>
      <RouterLink :to="{ name: 'customer-catalog' }" class="matching__all">
        {{ t('customer.home.matching.all') }} <span aria-hidden="true">{{ '↗' }}</span>
      </RouterLink>
    </header>
    <ul class="matching__cards" role="list">
      <li
        v-for="item in items"
        :key="item.productId"
        class="card"
        :class="{ 'card--out': home.stockOf(item) === 0 }"
        data-testid="home-matching-card"
      >
        <div class="card__photo">
          <HomeProductPhoto :src="item.imageUrl" :alt="item.name" />
          <span v-if="badge(item) !== null" class="card__badge" data-testid="home-stock-badge">
            {{ badge(item) }}
          </span>
        </div>
        <p class="card__why" data-testid="home-matching-why">
          {{ t('customer.home.matching.why', { name: item.boughtProductName }) }}
        </p>
        <h3 class="card__name">{{ item.name }}</h3>
        <div class="card__foot">
          <HomePrice :amount="item.price" class="card__price" />
          <div class="card__action">
            <QuantityStepper
              v-if="home.quantityOf(item) !== null"
              :model-value="home.quantityOf(item) ?? '1'"
              :label="t('customer.quantity.label', { name: item.name })"
              :name="item.name"
              :commit="home.commitFor(item)"
              :max="home.stockOf(item)"
              :unit="item.unit"
            />
            <AppButton
              v-else
              variant="secondary"
              size="md"
              block
              :soft-disabled="home.stockOf(item) === 0"
              :loading="home.isPending(item)"
              :aria-label="`${t('customer.home.matching.add')}: ${item.name}`"
              data-testid="home-matching-add"
              @click="home.add(item, 1)"
            >
              <span class="card__plus" aria-hidden="true">{{ '+' }}</span>
              <span class="card__add-text">{{ t('customer.home.matching.add') }}</span>
            </AppButton>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.matching {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.matching__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.matching__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}
.matching__all {
  display: flex;
  align-items: center;
  flex: none;
  min-height: var(--tap-min);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
  font-weight: 500;
}
/* Phone: one row that scrolls sideways, bleeding to the screen edges like the design. */
.matching__cards {
  display: flex;
  gap: 10px;
  margin: 0 -16px;
  padding: 0 16px;
  overflow-x: auto;
  scrollbar-width: none;
  list-style: none;
  scroll-snap-type: x proximity;
}
.matching__cards::-webkit-scrollbar {
  display: none;
}
.card {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  width: 156px;
  padding: 10px;
  border-radius: var(--r-panel);
  background: var(--w);
  scroll-snap-align: start;
}
.card__photo {
  position: relative;
}
.card__badge {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 3px 7px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: 10px;
  font-weight: 600;
}
.card__why {
  margin: 0;
  min-height: 26px;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--acc-fg);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.card__name {
  margin: 0;
  min-height: 31px;
  font-size: var(--fs-meta);
  font-weight: 600;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.card__foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}
.card__price {
  font-size: var(--fs-body);
  font-weight: 700;
  min-width: 0;
}
.card__action {
  flex: none;
}
/* The plus alone on a phone (a 44px square), the word from the tablet up. */
.card__action :deep(.btn) {
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  padding: 0 12px;
  background: var(--acc-bg);
  color: var(--acc-fg);
}
.card__plus {
  font-size: 20px;
  line-height: 1;
}
.card__add-text {
  display: none;
}
.card--out .card__name,
.card--out .card__price {
  color: var(--t3);
}
.card--out .card__badge {
  background: var(--f5);
  color: var(--t2);
}
/* The stepper in a card: the tint of the design's in-cart control, full width. */
.card__action :deep(.stepper__box) {
  border-color: transparent;
  background: var(--acc-bg);
}
.card__action :deep(.stepper__btn) {
  background: transparent;
  color: var(--acc-fg);
}
.card__action :deep(.stepper__input) {
  color: var(--acc-fg);
}
.card__action :deep(.stepper__note) {
  max-width: none;
}

@media (min-width: 640px) {
  .matching__cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    overflow: visible;
  }
  .card {
    width: auto;
    gap: 8px;
  }
  .card__why {
    font-size: var(--fs-group);
  }
  .card__name {
    min-height: 34px;
    font-size: var(--fs-small);
  }
  .card__price {
    font-size: var(--fs-body-lg);
  }
}

@media (min-width: 960px) {
  .matching__cards {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  /* Desktop: the price on its own line, the button full width under it (design 1280). */
  .card__foot {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .card__action,
  .card__action :deep(.stepper) {
    width: 100%;
    align-items: stretch;
  }
  .card__action :deep(.stepper__box) {
    width: 100%;
  }
  .card__action :deep(.stepper__input) {
    flex: 1;
    width: auto;
  }
  .card__plus {
    display: none;
  }
  .card__add-text {
    display: inline;
  }
  .card:hover {
    box-shadow: 0 0 0 1px var(--e8);
  }
}
</style>
