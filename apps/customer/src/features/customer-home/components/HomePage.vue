<script setup lang="ts">
import { computed, onActivated } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useCustomerServices } from '@/features/customer-app/services';
import arrowAccentIcon from '@/features/customer-app/assets/icons/arrow-accent.svg';
import gridAccentIcon from '@/features/customer-app/assets/icons/grid-accent.svg';
import receiptIcon from '@/features/customer-app/assets/icons/receipt.svg';
import AmountToPayCard from '@/features/customer-balance/components/AmountToPayCard.vue';
import CartSummaryBar from '@/features/customer-cart/components/CartSummaryBar.vue';
import { planTotal } from '@/features/customer-cart/domain/payment-plan';
import { stateLabelKey } from '@/features/customer-orders/domain/order-display';
import { useHomeCart } from '../composables/use-home-cart';
import { heroOf, isFirstVisit, matchingCardsOf } from '../domain/home-blocks';
import HomeActiveOrder from './HomeActiveOrder.vue';
import HomeFirstVisit from './HomeFirstVisit.vue';
import HomeHero from './HomeHero.vue';
import HomeMatchingCards from './HomeMatchingCards.vue';
import HomePrice from './HomePrice.vue';
import HomeReorderList from './HomeReorderList.vue';

// The customer home, design "2a" [C, owner 2026-11-09]: a greeting with the active order and the
// cart, the amount to pay, then recommendations that match what the shop bought (a confirmed newer
// model, products to reorder, matching products), the catalog entry and the recent orders. A shop
// with no purchase history (and a staff viewer) gets the first-visit home instead of empty blocks.
const { t } = useI18n();
const { session, ordersApi, homeApi, cart } = useCustomerServices();
const home = useHomeCart();

const orders = useAsyncView(
  async () => {
    const [activePage, recentPage] = await Promise.all([
      ordersApi.list({ group: 'ACTIVE', limit: 1 }),
      ordersApi.list({ group: 'COMPLETED', limit: 2 }),
    ]);
    return { active: activePage.orders[0] ?? null, recent: recentPage.orders };
  },
  { isEmpty: () => false },
);
const recs = useAsyncView(() => homeApi.getRecommendations(), { isEmpty: () => false });
// The page stays alive between visits; what was bought may have changed meanwhile.
onActivated(() => {
  void recs.reload();
  void orders.reload();
});

const name = computed(() => session.me.value?.fullName ?? '');
const firstName = computed(() => name.value.trim().split(/\s+/)[0] ?? '');
const initials = computed(() =>
  name.value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join(''),
);
const organization = computed(
  () =>
    session.organizationName.value ??
    (session.staffViewer.value ? t('customer.viewer.noShop') : t('customer.presentation.yourShop')),
);
const active = computed(() => orders.data.value?.active ?? null);
const recent = computed(() => orders.data.value?.recent ?? []);

const firstVisit = computed(() => recs.data.value !== null && isFirstVisit(recs.data.value));
const hero = computed(() => (recs.data.value === null ? null : heroOf(recs.data.value)));
const reorder = computed(() => recs.data.value?.reorder ?? []);
const cards = computed(() => (recs.data.value === null ? [] : matchingCardsOf(recs.data.value)));
// "Days ago" counts from the moment the page was built; a reload rebuilds it.
const now = new Date();

const hasCart = computed(() => cart.itemCount.value > 0 && cart.cart.value !== null);
const cartTotal = computed(() => {
  const current = cart.cart.value;
  if (current === null) return null;
  return planTotal(current, cart.paymentPlan.value) ?? current.totalAmount;
});
</script>

<template>
  <section class="home" :class="{ 'home--with-bar': hasCart }">
    <div class="top">
      <div class="greeting">
        <p class="eyebrow">
          {{ session.staffViewer.value ? t('customer.viewer.label') : organization }}
        </p>
        <h1>{{ t('customer.presentation.greeting', { name: firstName }) }}</h1>
        <p class="subtitle">{{ t('customer.home.subtitle') }}</p>
      </div>
      <RouterLink
        :to="{ name: 'customer-profile' }"
        class="avatar"
        :aria-label="t('customer.presentation.profile')"
        >{{ initials }}</RouterLink
      >
      <div class="chips">
        <HomeActiveOrder v-if="active" :order="active" />
        <p v-else-if="orders.state.value === 'error'" class="inline-error" role="alert">
          <span>{{ t('state.error.title') }}</span>
          <AppButton variant="secondary" size="sm" @click="orders.reload()">
            {{ t('state.retry') }}
          </AppButton>
        </p>
        <RouterLink
          v-if="hasCart && cartTotal !== null"
          :to="{ name: 'customer-cart' }"
          class="cart-chip"
          :aria-label="
            t('customer.home.cartChipLabel', {
              count: cart.itemCount.value,
              total: cartTotal,
            })
          "
          data-testid="home-cart-chip"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2" />
          </svg>
          <span>{{ t('customer.home.cartChip', { count: cart.itemCount.value }) }}</span>
          <span aria-hidden="true">{{ '·' }}</span>
          <HomePrice :amount="cartTotal" />
        </RouterLink>
      </div>
    </div>

    <AmountToPayCard />

    <div
      class="recs"
      :aria-busy="recs.state.value === 'loading' || undefined"
      data-testid="home-recommendations"
      :data-state="recs.state.value"
    >
      <template v-if="recs.state.value === 'loading'">
        <p class="sr-only" role="status">{{ t('customer.home.loading') }}</p>
        <div class="skeleton skeleton--hero" aria-hidden="true" />
        <div class="skeleton skeleton--list" aria-hidden="true" />
      </template>
      <p v-else-if="recs.state.value === 'error'" class="inline-error" role="alert">
        <span>{{ t('customer.home.error') }}</span>
        <AppButton variant="secondary" size="sm" @click="recs.reload()">
          {{ t('state.retry') }}
        </AppButton>
      </p>
      <HomeFirstVisit v-else-if="firstVisit" />
      <template v-else-if="recs.data.value !== null">
        <div v-if="hero || reorder.length" class="row-hero">
          <HomeHero v-if="hero" :hero="hero" />
          <HomeReorderList v-if="reorder.length" :items="reorder" :now="now" />
        </div>
        <HomeMatchingCards v-if="cards.length" :items="cards" />
      </template>
    </div>

    <RouterLink :to="{ name: 'customer-catalog' }" class="catalog-entry"
      ><img :src="gridAccentIcon" alt="" width="24" height="24" />
      <div>
        <h2>{{ t('customer.presentation.productsPrices') }}</h2>
        <p>{{ t('customer.presentation.catalogHint') }}</p>
      </div>
      <img :src="arrowAccentIcon" alt="" width="24" height="24"
    /></RouterLink>

    <section v-if="recent.length" class="home-recent">
      <div class="section-head">
        <h2>{{ t('customer.presentation.recentOrders') }}</h2>
        <RouterLink :to="{ name: 'customer-orders' }"
          >{{ t('customer.presentation.history') }} {{ '↗' }}</RouterLink
        >
      </div>
      <RouterLink
        v-for="order in recent"
        :key="order.id"
        :to="{ name: 'customer-order', params: { id: order.id } }"
        class="recent-order"
        :aria-label="t('customer.orders.open', { number: order.orderNumber })"
      >
        <span class="recent-order__icon"
          ><img :src="receiptIcon" alt="" width="24" height="24"
        /></span>
        <span class="recent-order__identity"
          ><strong>{{ order.orderNumber }}</strong
          ><span>{{ t('customer.orders.positions', { count: order.itemCount }) }}</span></span
        >
        <span class="recent-order__total"
          ><HomePrice :amount="order.totalAmount" class="recent-order__amount" /><span
            data-testid="recent-order-state"
            >{{ t(stateLabelKey(order.status)) }}</span
          ></span
        >
      </RouterLink>
    </section>

    <!-- On a phone the cart is the floating bar of the price list; wider screens have the chip. -->
    <div class="home__bar"><CartSummaryBar /></div>
    <p class="sr-only" role="status" aria-live="polite">
      <span :key="home.announcementSeq.value">{{ home.announcement.value }}</span>
    </p>
  </section>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Keeps the last rows clear of the bar that sits above the bottom menu. */
.home--with-bar {
  padding-bottom: 72px;
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
h2 {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}
.top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'greeting avatar'
    'chips chips';
  gap: 16px 12px;
  align-items: center;
}
.greeting {
  grid-area: greeting;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.eyebrow {
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--t3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.subtitle {
  display: none;
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t3);
}
.avatar {
  grid-area: avatar;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: 12px;
  font-weight: 600;
}
.chips {
  grid-area: chips;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.chips:empty {
  display: none;
}
.cart-chip {
  display: none;
  align-items: center;
  gap: 8px;
  min-height: var(--tap-min);
  padding: 0 16px;
  border-radius: var(--r-input);
  background: var(--hero-bg);
  color: var(--hero-fg);
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
}
.recs {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.row-hero {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.inline-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--r-panel);
  background: var(--w);
  color: var(--t2);
  font-size: var(--fs-small);
}
.skeleton {
  border-radius: var(--r-card);
  background: var(--w);
}
.skeleton--hero {
  height: 180px;
  background: var(--acc-bg3);
}
.skeleton--list {
  height: 220px;
}
.catalog-entry {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  min-height: 100px;
  border-radius: 18px;
  background: var(--acc-bg);
  color: var(--ink);
}
.catalog-entry > div {
  flex: 1;
  min-width: 0;
}
.catalog-entry h2 {
  font-size: 17px;
}
.catalog-entry p {
  margin: 4px 0 0;
  font-size: var(--fs-meta);
  color: var(--t3);
}
.home-recent {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.section-head a {
  display: flex;
  align-items: center;
  min-height: var(--tap-min);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
}
.recent-order {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  color: var(--ink);
}
.recent-order__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: var(--r-input);
  background: var(--w);
}
.recent-order__identity,
.recent-order__total {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-body);
}
.recent-order__identity {
  flex: 1;
  min-width: 0;
}
.recent-order__total {
  text-align: right;
  font-size: var(--fs-small);
}
.recent-order__amount {
  font-weight: 700;
}
.recent-order__identity > span,
.recent-order__total > span:last-child {
  font-size: 11px;
  color: var(--t3);
}

@media (min-width: 640px) {
  .home {
    gap: 20px;
  }
  .home--with-bar {
    padding-bottom: 0;
  }
  .home__bar {
    display: none;
  }
  h1 {
    font-size: 24px;
    letter-spacing: -0.02em;
  }
  /* Tablet: the cart chip beside the greeting, the active order as a bar underneath. */
  .top {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'greeting chips'
      'order order';
    gap: 20px 12px;
  }
  .avatar {
    display: none;
  }
  .chips {
    display: contents;
  }
  .chips > .active-order {
    grid-area: order;
  }
  .chips > .inline-error {
    grid-area: order;
  }
  .cart-chip {
    grid-area: chips;
    display: inline-flex;
    justify-self: end;
  }
  .recs,
  .row-hero {
    gap: 20px;
  }
}

@media (min-width: 960px) {
  .home {
    gap: 24px;
  }
  h1 {
    font-size: 28px;
  }
  .eyebrow {
    display: none;
  }
  .subtitle {
    display: block;
  }
  .greeting {
    gap: 4px;
  }
  /* Desktop: greeting left, both chips right in one row. */
  .top {
    grid-template-areas: 'greeting chips';
    gap: 16px;
  }
  .chips {
    display: flex;
    flex-direction: row;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    grid-area: chips;
  }
  .chips > .active-order {
    grid-area: auto;
  }
  .cart-chip {
    grid-area: auto;
  }
  .row-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    align-items: start;
    gap: 16px;
  }
  .row-hero > :only-child {
    grid-column: 1 / -1;
  }
}
</style>
