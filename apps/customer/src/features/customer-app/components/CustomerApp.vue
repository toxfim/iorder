<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import GoodsDiscovery from '@/features/customer-goods/components/GoodsDiscovery.vue';
import BrandLogo from '@core/components/brand/BrandLogo.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppErrorBoundary from '@core/components/ui/AppErrorBoundary.vue';
import ToastHost from '@core/components/ui/ToastHost.vue';
import { useDocumentTitle } from '@core/composables/use-document-title';
import './customer-presentation.css';
import { useShellMetrics } from '../composables/use-shell-metrics';
import { useStartRoute } from '../composables/use-start-route';
import { useCustomerServices } from '../services';
import AccessState from './AccessState.vue';
import ViewerNotice from './ViewerNotice.vue';

const { t } = useI18n();
const route = useRoute();
const { session, cart, goods } = useCustomerServices();
// Teleported dialogs live outside .app and must use the same palette as the customer page.
onMounted(() => document.documentElement.setAttribute('data-customer-app', ''));
onBeforeUnmount(() => document.documentElement.removeAttribute('data-customer-app'));
useDocumentTitle();

const root = ref<HTMLElement | null>(null);
const header = ref<HTMLElement | null>(null);
const tabs = ref<HTMLElement | null>(null);
useShellMetrics(root, header, tabs);

const NAV = [
  { name: 'customer-home', labelKey: 'customer.presentation.home', icon: 'home' },
  { name: 'customer-catalog', labelKey: 'customer.presentation.products', icon: 'grid' },
  { name: 'customer-orders', labelKey: 'customer.orders.title', icon: 'orders' },
  { name: 'customer-cart', labelKey: 'nav.customer.cart', icon: 'cart' },
  { name: 'customer-profile', labelKey: 'customer.presentation.profile', icon: 'profile' },
] as const;

void session.load();
// A Mini App direct link with a `startapp` value opens its screen: the price list (the price
// list posts) or one order (the buttons under the bot's order messages).
useStartRoute(session.state, useRouter());
watch(
  () =>
    [
      session.state.value,
      session.me.value?.userId,
      session.me.value?.membership?.organizationId,
    ] as const,
  ([state]) => {
    goods.clear();
    if (state === 'ready') void goods.refresh();
  },
);
// The cart is loaded once the person is known, so the menu badge is right on every page.
watch(
  () => session.state.value,
  (state) => {
    if (state === 'ready') void cart.load();
  },
  { immediate: true },
);
</script>

<template>
  <div
    ref="root"
    class="app"
    :class="{
      'app--entry': session.state.value !== 'ready',
      'app--login': session.state.value === 'no-telegram',
    }"
  >
    <header ref="header" class="app__header">
      <BrandLogo :height="32" style="height: var(--customer-logo-height, 32px)" />
      <div class="app__spacer" />
    </header>

    <!-- Bottom navigation on mobile, a persistent left sidebar on desktop. -->
    <nav
      v-if="session.state.value === 'ready'"
      ref="tabs"
      class="tabs"
      :aria-label="t('nav.ariaLabel')"
    >
      <RouterLink
        v-for="item in NAV"
        :key="item.name"
        :to="{ name: item.name }"
        class="tab"
        :class="{ 'tab--active': route.meta.navGroup === item.name }"
        active-class="tab--active"
      >
        <span class="tab__icon" :class="`tab__icon--${item.icon}`" aria-hidden="true" />
        <span class="tab__label">{{ t(item.labelKey) }}</span>
        <template v-if="item.name === 'customer-cart' && cart.itemCount.value > 0">
          <AppBadge shape="count" tone="neutral" aria-hidden="true">
            {{ cart.itemCount.value }}
          </AppBadge>
          <span class="sr-only">{{
            t('customer.nav.cartCount', { count: cart.itemCount.value })
          }}</span>
        </template>
      </RouterLink>
      <div class="sidebar-account">
        <span>{{
          session.staffViewer.value
            ? t('customer.viewer.label')
            : t('customer.presentation.yourShop')
        }}</span>
        <strong>{{ session.organizationName.value }}</strong>
        <span>{{ session.me.value?.fullName }}</span>
      </div>
    </nav>
    <main class="app__main">
      <AccessState v-if="session.state.value !== 'ready'" />
      <ViewerNotice v-if="session.state.value === 'ready'" />
      <AppErrorBoundary v-if="session.state.value === 'ready'" :reset-key="route.fullPath">
        <RouterView v-slot="{ Component }">
          <!-- The catalog keeps its list and place when the person comes back to it. -->
          <KeepAlive include="CatalogPage">
            <component :is="Component" :key="route.path" />
          </KeepAlive>
        </RouterView>
      </AppErrorBoundary>
    </main>
    <GoodsDiscovery />
    <ToastHost />
  </div>
</template>

<style scoped>
.app {
  /* Fallbacks until the shell has measured itself (see use-shell-metrics): the header and the
     menu heights. --customer-bottom-h is the room the BOTTOM menu takes (none on desktop). */
  --customer-header-h: 56px;
  --customer-tabs-h: calc(61px + env(safe-area-inset-bottom, 0px));
  --customer-bottom-h: var(--customer-tabs-h);
  --customer-content-top: var(--customer-header-h);
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--page);
}

.app__header {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  box-sizing: border-box;
  gap: 8px;
  min-height: var(--customer-header-h);
  padding: 6px 16px;
  background: var(--page);
  border-bottom: 1px solid var(--e8);
}

.app__spacer {
  flex: 1;
}

.app__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--gap-block);
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  min-width: 0;
  /* Room for the fixed bottom menu and the home-indicator inset. */
  padding: 16px 16px calc(var(--customer-bottom-h) + 20px);
}

/* The page fills the area under the header, so an empty, loading or error state (the shared
   StateView) is centred in what is left instead of hanging below a fixed top margin. */
.app__main > * {
  flex: 1;
}

.app__main :deep(.state) {
  margin-block: auto;
  padding-block: 24px;
}

.tabs {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: var(--z-sticky);
  display: flex;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  background: var(--w);
  border-top: 1px solid var(--e8);
}

.tab {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: 200px;
  min-height: var(--tap-min);
  padding: 8px 6px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--t3);
}

.tab:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.tab--active {
  background: var(--f5);
  color: var(--ink);
}
.sidebar-account {
  display: none;
}

/* Tablet: the same column, a little wider. */
@media (min-width: 640px) {
  .app__main {
    max-width: 960px;
    padding-right: 24px;
    padding-left: 24px;
  }
}

/* The sidebar occupies horizontal space only; measured sidebar heights must never offset content. */
@media (min-width: 960px) {
  .app {
    --customer-sidebar-w: 240px;
    --customer-logo-height: 40px;
    --customer-bottom-h: 0px;
    --customer-content-top: 0px;
    padding-inline-start: var(--customer-sidebar-w);
  }

  .app__header {
    position: fixed;
    inset-block-start: 0;
    inset-inline-start: 0;
    width: var(--customer-sidebar-w);
    height: 88px;
    padding: 20px 24px;
    border-inline-end: 1px solid var(--e8);
  }

  .app__main {
    max-width: 1200px;
    padding: 36px 32px 64px;
  }

  .tabs {
    position: fixed;
    inset-block-start: 88px;
    inset-block-end: 0;
    inset-inline-start: 0;
    inset-inline-end: auto;
    width: var(--customer-sidebar-w);
    flex-direction: column;
    justify-content: start;
    gap: 8px;
    padding: 12px 16px 24px;
    border-top: 0;
    border-inline-end: 1px solid var(--e8);
    overflow-y: auto;
  }

  .tab {
    flex: none;
    width: 100%;
    max-width: none;
    justify-content: start;
    border-radius: var(--r-input);
  }

  .sidebar-account {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: auto;
    padding: 24px 12px 0;
    font-size: var(--fs-meta);
    color: var(--t3);
    overflow-wrap: anywhere;
  }
  .sidebar-account strong {
    color: var(--ink);
    font-size: var(--fs-body);
  }
}
@media (min-width: 960px) {
  .app--entry {
    padding-inline-start: 0;
  }
  .app--entry .app__header {
    position: static;
    width: 100%;
    height: var(--customer-header-h);
  }
  .app--entry .app__main {
    max-width: 100%;
  }
}
.app.app--login > .app__header {
  display: none;
}
.app.app--login > .app__main {
  max-width: none;
  padding: 0;
  margin: 0;
}
</style>
