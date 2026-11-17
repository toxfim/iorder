<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import UserBlock from '@/features/auth/components/UserBlock.vue';
import { mayOpenCustomerSite } from '@/features/staff-customer-site/access';
import { markHandoffIntent } from '@/features/staff-customer-site/handoff-intent';
import { parseOrderFilters } from '@/features/staff-orders/domain/order-filters';
import { useFormat } from '@core/i18n/use-format';
import { navGroupsFor, staffRouteName } from '../nav-config';
import OrdersNavGroup from './OrdersNavGroup.vue';
import { canViewOrganizations } from '../organizations-access';
import { canViewPriceAdmin } from '../price-access';

const emit = defineEmits<{ navigate: [] }>();

const { t } = useI18n();
const route = useRoute();
const {
  currentUser,
  orderDebtStore,
  dashboardSummaryStore,
  priceVersionStore,
  unpricedCountStore,
  sheetAttentionStore,
  waitingOrganizationsStore,
  customerSiteStore,
} = useServices();
const { formatTime } = useFormat();
const router = useRouter();

// Hiding entries is a convenience; the server rejects what the role may not do.
const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const groups = computed(() => navGroupsFor(roles.value));
const canSee = (key: string): boolean =>
  groups.value.some((group) => group.pages.some((page) => page.key === key));
// The order list is the "All orders" child of the Orders group; the quick filters belong to it.
const seesOrderList = computed(() =>
  groups.value.some((group) => group.ordersChildren.some((child) => child.key === 'all')),
);

// Products waiting for a price: a number for the people who set prices, nothing for the rest.
const unpricedCount = computed(() =>
  canViewPriceAdmin(roles.value) ? (unpricedCountStore.count.value ?? 0) : 0,
);

// Sheet sync leftovers (removal requests, new unpriced products): for those who decide them.
const sheetAttentionCount = computed(() =>
  canViewPriceAdmin(roles.value) ? sheetAttentionStore.count.value : 0,
);

// Groups waiting for activation: only the people who may activate them see the number.
const waitingCount = computed(() =>
  canViewOrganizations(roles.value) ? (waitingOrganizationsStore.count.value ?? 0) : 0,
);

// Count badge of a plain entry; each has its own accessible name and test id.
interface EntryBadge {
  readonly count: number;
  readonly label: string;
  readonly testId: string;
}

const badges = computed<Readonly<Record<string, EntryBadge | undefined>>>(() => {
  const out: Record<string, EntryBadge> = {};
  const add = (key: string, count: number, messageKey: string, testId: string): void => {
    if (count > 0) out[key] = { count, label: t(messageKey, { count }, count), testId };
  };
  add('prices', unpricedCount.value, 'nav.unpricedBadge', 'unpriced-badge');
  add('stock', sheetAttentionCount.value, 'nav.sheetAttentionBadge', 'sheet-attention-badge');
  add(
    'organizations',
    waitingCount.value,
    'nav.waitingOrganizationsBadge',
    'waiting-organizations-badge',
  );
  return out;
});

// "Tez filtrlar": jumps to the orders list with a filter (v1: Bugungi, To'lanmagan). "Tasdiq
// kutmoqda" moved into the Orders group as the manager's own step.
const filters = computed(() => parseOrderFilters(route.query));
const onOrders = computed(() => route.name === 'staff-orders');
const quick = computed(() => [
  {
    key: 'today',
    label: t('nav.quick.today'),
    count: dashboardSummaryStore.summary.value?.today?.count ?? null,
    query: { period: 'today' },
    active: filters.value.period === 'today',
  },
  {
    key: 'debt',
    label: t('nav.quick.debt'),
    count: orderDebtStore.count.value,
    query: { period: 'debt' },
    active: filters.value.period === 'debt',
  },
]);

// The sidebar is dark in both themes (design v8), so it always shows the light-on-dark logo.
const logoSrc = `${import.meta.env.BASE_URL}header-dark.png`;
// The brand name is the same in every language, so it is not a translatable string.
const BRAND_NAME = 'iorder.uz';

const priceVersion = computed(() => (canSee('prices') ? priceVersionStore.version.value : null));

// "Mijoz sahifasi" ([C] 2026-11-09): continue on the customer site with this sign-in. Asked only
// for the roles that may be viewers there; shown only when the api names a site (it is hidden in
// the Mini App and where no site is configured).
watch(
  roles,
  (held) => {
    if (mayOpenCustomerSite(held)) void customerSiteStore.ensureLoaded();
  },
  { immediate: true },
);
const customerSite = computed(() => {
  const url = mayOpenCustomerSite(roles.value) ? customerSiteStore.url.value : null;
  if (url === null) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  // The handoff page of this app, opened in a new tab: it asks for the one-time code there, so
  // the code is never older than the moment the customer site opens.
  return { host, href: router.resolve({ name: 'customer-site-handoff' }).href };
});
</script>

<template>
  <div class="sidebar">
    <div class="sidebar__brand">
      <img :src="logoSrc" :alt="BRAND_NAME" class="sidebar__logo" />
    </div>

    <!-- v8 workspace card. The company is single-tenant: a static brand card, not a switcher. -->
    <div class="workspace">
      <StaffIcon name="warehouse" class="workspace__icon" />
      <span class="workspace__text">
        <span class="workspace__title">{{ t('nav.workspaceCard.title') }}</span>
        <span class="workspace__subtitle">{{ t('nav.workspaceCard.subtitle') }}</span>
      </span>
    </div>

    <nav :aria-label="t('nav.ariaLabel')" class="sidebar__nav">
      <div v-for="entry in groups" :key="entry.group" class="group">
        <span class="group__title">{{ t(`nav.groups.${entry.group}`) }}</span>
        <RouterLink
          v-for="page in entry.pages"
          :key="page.key"
          v-slot="{ href, navigate, isActive }"
          :to="{ name: staffRouteName(page) }"
          custom
        >
          <a
            :href="href"
            class="item"
            :class="{ 'item--active': isActive }"
            :aria-current="isActive ? 'page' : undefined"
            @click="
              (event) => {
                navigate(event);
                emit('navigate');
              }
            "
          >
            <StaffIcon :name="page.icon" class="item__icon" />
            <span class="item__label">{{ t(page.labelKey) }}</span>
            <span
              v-if="badges[page.key]"
              class="nav-badge"
              :class="{ 'nav-badge--on': isActive }"
              :aria-label="badges[page.key]?.label"
              :data-testid="badges[page.key]?.testId"
            >
              {{ badges[page.key]?.count }}
            </span>
          </a>
        </RouterLink>
        <OrdersNavGroup
          v-if="entry.ordersChildren.length > 0"
          :children="entry.ordersChildren"
          @navigate="emit('navigate')"
        />
      </div>

      <div v-if="seesOrderList" class="group">
        <span class="group__title">{{ t('nav.quickFilters') }}</span>
        <div class="quick">
          <RouterLink
            v-for="item in quick"
            :key="item.key"
            :to="{ name: 'staff-orders', query: item.query }"
            class="quick__item"
            :class="{ 'quick__item--on': onOrders && item.active }"
            @click="emit('navigate')"
          >
            <span>{{ item.label }}</span>
            <span class="quick__count num">{{ item.count ?? '–' }}</span>
          </RouterLink>
        </div>
      </div>
    </nav>

    <div class="sidebar__bottom">
      <a
        v-if="customerSite"
        :href="customerSite.href"
        target="_blank"
        rel="noopener"
        class="card"
        data-testid="customer-site-entry"
        :aria-label="t('customerSite.openInNewTab')"
        @click="
          markHandoffIntent();
          emit('navigate');
        "
      >
        <StaffIcon name="external" :size="15" class="card__icon" />
        <span class="card__text">
          <span class="card__title">{{ t('customerSite.entry') }}</span>
          <span class="card__version">{{ customerSite.host }}</span>
        </span>
      </a>
      <RouterLink
        v-if="priceVersion"
        :to="{ name: 'staff-prices' }"
        class="card"
        @click="emit('navigate')"
      >
        <StaffIcon name="tags" :size="15" class="card__icon" />
        <span class="card__text">
          <span class="card__title">{{ t('nav.priceCard.title') }}</span>
          <span class="card__version">
            {{
              t('nav.priceCard.version', {
                number: priceVersion.number,
                time: formatTime(priceVersion.publishedAt),
              })
            }}
          </span>
        </span>
      </RouterLink>
    </div>

    <div class="sidebar__user">
      <UserBlock />
      <span class="sidebar__footer">{{ t('nav.footer') }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * Design v8: a dark sidebar in both themes, every colour from the --side-* tokens. The local
 * tokens below make the shared pieces inside it (the user block) read light-on-dark.
 */
.sidebar {
  --ink: var(--side-strong);
  --t2: var(--side-fg);
  --t3: var(--side-muted);
  --w: var(--side-hover);
  --f5: var(--side-line);
  --e8: var(--side-line);
  --btn-ink-bg: var(--side-line);
  --btn-ink-fg: var(--side-strong);

  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 8px 16px 0;
  background: var(--side-bg);
  color: var(--side-fg);
  font-size: var(--fs-small);
}

.sidebar__brand {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  height: 124px;
}

/* v8 draws a padded 150px logo image; ours is the bare wordmark, so it is narrower. */
.sidebar__logo {
  width: 132px;
  height: auto;
}

.workspace {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  height: 57px;
  padding: 12px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--side-line);
}

.workspace__icon {
  color: var(--side-icon-active);
}

.workspace__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.workspace__title {
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--side-strong);
}

.workspace__subtitle {
  font-size: var(--fs-group);
  color: var(--side-fg);
}

.sidebar__nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 28px;
  padding: 30px 0;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group__title {
  padding: 0 12px 3px;
  font-size: var(--fs-group);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--side-muted);
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 43px;
  padding: 0 12px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-small);
  color: var(--side-fg);
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.item:hover {
  color: var(--side-strong);
}

.item__icon {
  color: var(--side-fg);
}

.item__label {
  flex: 1;
  min-width: 0;
}

.item--active {
  background: var(--side-active);
  color: var(--side-strong);
  font-weight: 600;
}

.item--active .item__icon {
  color: var(--side-icon-active);
}

/* v8 sidebar counter: a 4px chip on the line colour, orange on the open entry. */
.nav-badge {
  flex: none;
  padding: 2px 6px;
  border-radius: var(--r-kbd);
  background: var(--side-line);
  font-size: var(--fs-group);
  font-weight: 400;
  line-height: 1.4;
  color: var(--side-strong);
  font-variant-numeric: tabular-nums;
}

.nav-badge--on {
  background: var(--side-icon-active);
  color: var(--acc-on);
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 8px;
}

.quick__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  box-shadow: inset 0 0 0 1px var(--side-line);
  font-size: var(--fs-meta);
  color: var(--side-fg);
}

.quick__item:hover,
.quick__item--on {
  color: var(--side-strong);
}

.quick__item--on {
  background: var(--side-active);
}

.quick__count {
  color: var(--side-muted);
}

.quick__item--on .quick__count {
  color: var(--side-strong);
}

/* Pushes the price list card down to the user block. */
.sidebar__bottom {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  padding: 24px 0 20px;
}

.card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  border-radius: var(--r-btn-sm);
  background: var(--side-line);
  color: var(--side-fg);
}

.card__icon {
  color: var(--side-icon-active);
}

.card__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

/* A long host name stays on its line instead of pushing the card wider than the sidebar. */
.card__version {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__title {
  font-size: var(--fs-meta);
  color: var(--side-strong);
}

.card__version {
  font-size: var(--fs-group);
  color: var(--side-fg);
}

/* Sticks to the bottom edge while the menu scrolls; a fade hints at the entries under it. */
.sidebar__user {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 18px;
  margin: 0 -16px;
  /* In the phone drawer this block is the last row of the screen (AppDrawer pads the top). */
  padding: 14px 16px calc(20px + var(--safe-bottom, 0px));
  background: var(--side-bg);
  box-shadow: 0 -1px 0 var(--side-line);
}

.sidebar__user::before {
  content: '';
  position: absolute;
  top: -37px;
  right: 0;
  left: 0;
  height: 36px;
  background: linear-gradient(to bottom, transparent, var(--side-bg));
  pointer-events: none;
}

.sidebar__footer {
  font-size: 9px;
  color: var(--side-dim);
  white-space: pre;
}

.item:focus-visible,
.quick__item:focus-visible,
.card:focus-visible {
  outline: 2px solid var(--side-icon-active);
  outline-offset: 1px;
}

/* Touch devices: 44px hit area. */
@media (pointer: coarse) {
  .item,
  .quick__item {
    min-height: 44px;
  }
}
</style>
