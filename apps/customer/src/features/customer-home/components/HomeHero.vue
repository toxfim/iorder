<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import { useFormat } from '@core/i18n/use-format';
import QuantityStepper from '@/features/customer-cart/components/QuantityStepper.vue';
import { useHomeCart } from '../composables/use-home-cart';
import type { HomeHero } from '../domain/home-blocks';
import HomePrice from './HomePrice.vue';
import HomeProductPhoto from './HomeProductPhoto.vue';

// The big tinted card at the top (design "2a"): the newer model of something the shop buys, from
// a pair staff confirmed, or, without one, the first matching product under a neutral label.
const props = defineProps<{ hero: HomeHero }>();

const { t } = useI18n();
const { formatNumber, formatUnit } = useFormat();
const home = useHomeCart();

const item = computed(() => props.hero.item);
const label = computed(() =>
  props.hero.kind === 'newer' ? t('customer.home.hero.newModel') : t('customer.home.hero.pick'),
);
const why = computed(() => {
  if (props.hero.kind === 'pick') {
    return t('customer.home.matching.why', { name: props.hero.item.boughtProductName });
  }
  const { replacesProductName: name, replacesTimesOrdered: count } = props.hero.item;
  return count === 1
    ? t('customer.home.hero.whyOnce', { name })
    : t('customer.home.hero.whyMany', { name, count });
});
const stock = computed(() => home.stockOf(item.value));
const inCart = computed(() => home.quantityOf(item.value));
const unit = computed(() => formatUnit(item.value.unit));
</script>

<template>
  <article
    class="hero-card"
    :class="{ 'hero-card--out': stock === 0 }"
    data-testid="home-hero"
    :data-kind="hero.kind"
  >
    <div class="hero-card__body">
      <span class="hero-card__label">{{ label }}</span>
      <h2 class="hero-card__name">{{ item.name }}</h2>
      <p class="hero-card__why" data-testid="home-hero-why">{{ why }}</p>
    </div>
    <HomeProductPhoto
      class="hero-card__photo"
      :src="item.imageLargeUrl ?? item.imageUrl"
      :alt="item.name"
    />
    <div class="hero-card__foot">
      <div class="hero-card__price">
        <HomePrice :amount="item.price" class="hero-card__amount" />
        <span v-if="stock !== null" class="hero-card__stock" data-testid="home-hero-stock">
          {{
            stock === 0
              ? t('customer.home.stock.out')
              : t('customer.home.hero.stock', { count: formatNumber(String(stock)), unit })
          }}
        </span>
      </div>
      <div class="hero-card__action">
        <QuantityStepper
          v-if="inCart !== null"
          :model-value="inCart"
          :label="t('customer.quantity.label', { name: item.name })"
          :name="item.name"
          :commit="home.commitFor(item)"
          :max="stock"
          :unit="item.unit"
        />
        <AppButton
          v-else
          variant="primary"
          size="lg"
          :soft-disabled="stock === 0"
          :loading="home.isPending(item)"
          :aria-label="`${t('customer.home.hero.add')}: ${item.name}`"
          data-testid="home-hero-add"
          @click="home.add(item, 1)"
        >
          {{ t('customer.home.hero.add') }}
        </AppButton>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* Phone: text left of the photo, the price and the control share one row underneath, so the
   photo stays large and the button keeps its 44px. */
.hero-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 118px;
  grid-template-areas:
    'body photo'
    'foot foot';
  gap: 12px;
  align-items: center;
  padding: 16px;
  border-radius: var(--r-card);
  background: var(--acc-bg);
  color: var(--ink);
}
.hero-card__body {
  grid-area: body;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.hero-card__label {
  padding: 3px 8px;
  border-radius: var(--r-kbd);
  background: var(--w);
  color: var(--acc-fg);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.hero-card__name {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.hero-card__why {
  margin: 0;
  font-size: var(--fs-group);
  line-height: 1.4;
  color: var(--t3);
  text-wrap: pretty;
}
.hero-card__photo {
  grid-area: photo;
  border-radius: var(--r-row);
}
.hero-card__foot {
  grid-area: foot;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.hero-card__price {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hero-card__amount {
  font-size: 18px;
  font-weight: 700;
}
.hero-card__stock {
  font-size: var(--fs-group);
  color: var(--t3);
}
.hero-card__action {
  display: flex;
  flex: none;
}
.hero-card--out .hero-card__name,
.hero-card--out .hero-card__amount {
  color: var(--t3);
}
.hero-card--out .hero-card__stock {
  font-weight: 600;
  color: var(--t2);
}
/* The stepper inside the tinted card sits on white, like the design's in-cart control. */
.hero-card__action :deep(.stepper__box) {
  background: var(--w);
}

/* Tablet and up: the photo takes the whole right column, the foot stacks under the text. */
@media (min-width: 640px) {
  .hero-card {
    grid-template-columns: minmax(0, 1fr) 220px;
    grid-template-areas:
      'body photo'
      'foot photo';
    gap: 12px 16px;
    padding: 22px;
  }
  .hero-card__body {
    align-self: end;
    gap: 12px;
  }
  .hero-card__name {
    font-size: 24px;
  }
  .hero-card__why {
    font-size: var(--fs-small);
  }
  .hero-card__foot {
    align-self: start;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .hero-card__price {
    flex-direction: row;
    align-items: baseline;
    gap: 10px;
  }
  .hero-card__amount {
    font-size: 22px;
  }
  .hero-card__stock {
    font-size: var(--fs-meta);
  }
  .hero-card__photo {
    border-radius: var(--r-panel);
  }
}

@media (min-width: 960px) {
  .hero-card {
    grid-template-columns: minmax(0, 1fr) 210px;
    padding: 24px;
  }
  .hero-card__name {
    font-size: 26px;
    letter-spacing: -0.01em;
  }
  .hero-card__amount {
    font-size: 24px;
  }
}
</style>
