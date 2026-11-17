<script setup lang="ts">
import type { StaffRole } from '@iorder/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppErrorBoundary from '@core/components/ui/AppErrorBoundary.vue';
import AppDrawer from '@/components/ui/AppDrawer.vue';
import AppIcon from '@core/components/ui/AppIcon.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import LocaleSwitcher from '@/features/preferences/components/LocaleSwitcher.vue';
import ThemeSwitcher from '@/features/preferences/components/ThemeSwitcher.vue';
import CommandPalette from '@/features/search/components/CommandPalette.vue';
import SearchButton from '@/features/search/components/SearchButton.vue';
import BotNotificationsReminder from '@/features/staff-notifications/components/BotNotificationsReminder.vue';
import { syncTelegramChrome } from '@/features/preferences/telegram-chrome';
import { businessParts } from '@core/lib/business-clock';
import { initialsOf } from '@/features/directory/domain/directory-model';
import NotificationsBell from './NotificationsBell.vue';
import SidebarContent from './SidebarContent.vue';
import { canViewOrganizations } from '../organizations-access';
import { canViewPriceAdmin } from '../price-access';
import { readsAllOrders, seesOrderMoney } from '../orders-access';
import { MANAGER_SCOPE } from '@/features/staff-orders/domain/order-scopes';
import { STAFF_PAGES, hasSummaryQueueChild } from '../nav-config';

const { t } = useI18n();
const route = useRoute();

// v8 breadcrumb: "Ish maydoni > <page>". The page label comes from the same list as the sidebar.
// Pages below a section (an order, a price version) show their section, so the bar is never empty.
const crumb = computed(() => {
  const page =
    STAFF_PAGES.find((entry) => `staff-${entry.key}` === route.name) ??
    STAFF_PAGES.find((entry) => route.path.startsWith(`/staff/${entry.path}/`));
  return page ? t(page.labelKey) : null;
});
const menuOpen = ref(false);
const {
  ordersStore,
  orderDebtStore,
  directoryStore,
  activityStore,
  priceVersionStore,
  unpricedCountStore,
  sheetAttentionStore,
  waitingOrganizationsStore,
  dashboardSummaryStore,
  currentUser,
  commandPalette,
  clock,
} = useServices();

// v8 top bar date ("20 oktyabr 2026"), the business day in Asia/Tashkent. Read once per page:
// the bar re-renders on every navigation, which is often enough for a day label.
const today = computed(() => {
  void route.path;
  const parts = businessParts(clock.now());
  return t('dates.long', {
    day: parts.day,
    month: t(`dates.months.${parts.month - 1}`),
    year: parts.year,
  });
});
const userName = computed(() => currentUser.user.value?.displayName ?? '');
const userInitials = computed(() => initialsOf(userName.value));

// A route change from anywhere (link, back button) also closes the mobile menu; only a change of
// page (not of its query, such as an opened drawer) scrolls back to the top.
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
  },
);
watch(
  () => route.path,
  () => window.scrollTo?.(0, 0),
);

// The Qoldiq badge would otherwise show the numbers of the moment the area opened. Re-read it when
// the pages that change them open (Qoldiq, Narxlar), and when the unpriced count moves (a price was
// set, a product appeared). Only for the people who see the badge.
const SHEET_ATTENTION_PATH = /^\/staff\/(stock|prices)(\/|$)/;
watch(
  () => route.path,
  (path) => {
    if (
      SHEET_ATTENTION_PATH.test(path) &&
      canViewPriceAdmin(currentUser.user.value?.staffRoles ?? [])
    )
      void sheetAttentionStore.refresh();
  },
);
watch(unpricedCountStore.count, (_next, previous) => {
  // The first answer is read together with the badge on mount.
  if (previous !== null && canViewPriceAdmin(currentUser.user.value?.staffRoles ?? []))
    void sheetAttentionStore.refresh();
});

// Ctrl/Cmd+K opens the global search from anywhere in the staff area (specs.md section 6).
function onShortcut(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    commandPalette.open();
  }
}

let stopSummaryRefresh: (() => void) | null = null;

/** Roles whose sidebar shows a number that only the dashboard summary keeps current. */
const keepsSummaryLive = (roles: readonly StaffRole[]): boolean =>
  hasSummaryQueueChild(roles) || readsAllOrders(roles);

// The data every staff screen shares is read once when the area opens.
onMounted(() => {
  document.documentElement.setAttribute('data-staff-app', '');
  // The staff palette is on now: Telegram's own header takes the colour of the top bar.
  syncTelegramChrome();
  window.addEventListener('keydown', onShortcut);
  // No page downloads the order history: lists page on the server. Every page of a manager or
  // admin keeps the manager's queue (sidebar badge, home page); the role pages add their own.
  const roles = currentUser.user.value?.staffRoles ?? [];
  if (readsAllOrders(roles)) void ordersStore.loadBase(MANAGER_SCOPE);
  // The debt and "today" figures of the sidebar and the home page come from server counts.
  if (seesOrderMoney(roles)) {
    void orderDebtStore.refresh();
    // "Today" of the sidebar; roles with a live summary read it below.
    if (!keepsSummaryLive(roles)) void dashboardSummaryStore.refresh();
  }
  void directoryStore.load();
  void activityStore.refresh();
  void priceVersionStore.refresh();
  // Only the people who set prices see the number (the api would refuse the others anyway).
  if (canViewPriceAdmin(currentUser.user.value?.staffRoles ?? [])) {
    void unpricedCountStore.refresh();
    // Pending sheet decisions (Qoldiq badge); only the people who decide them see the number.
    void sheetAttentionStore.refresh();
  }
  // Groups the bot created wait for a manager or admin to activate them.
  if (canViewOrganizations(currentUser.user.value?.staffRoles ?? [])) {
    void waitingOrganizationsStore.refresh();
  }
  // The sidebar counts of accountant, warehouse and driver come from the dashboard summary; keep
  // them live on every page, not only where the summary panel is open. The manager's "waiting for
  // approval" badge needs it too: the summary is what notices an order placed after the list was
  // read (awaiting-approval.ts). The store shares one timer with the panel's own subscription.
  if (keepsSummaryLive(roles)) {
    void dashboardSummaryStore.refresh();
    stopSummaryRefresh = dashboardSummaryStore.startAutoRefresh();
  }
});
onBeforeUnmount(() => {
  document.documentElement.removeAttribute('data-staff-app');
  window.removeEventListener('keydown', onShortcut);
  stopSummaryRefresh?.();
});
</script>

<template>
  <div class="shell">
    <aside class="shell__sidebar">
      <SidebarContent />
    </aside>

    <div class="shell__column">
      <header class="topbar">
        <AppButton
          class="topbar__menu"
          variant="secondary"
          size="lg"
          :aria-label="t('nav.openMenu')"
          @click="menuOpen = true"
        >
          <AppIcon name="menu" :size="18" :stroke-width="2" />
        </AppButton>
        <nav v-if="crumb" class="crumb" :aria-label="t('nav.breadcrumb')">
          <RouterLink :to="{ name: 'staff-home' }" class="crumb__root">
            {{ t('nav.workspace') }}
          </RouterLink>
          <StaffIcon name="right" :size="13" class="crumb__sep" />
          <span class="crumb__page" aria-current="page">{{ crumb }}</span>
        </nav>
        <div class="topbar__spacer" />
        <div class="topbar__tools">
          <SearchButton />
          <span class="topbar__date" data-testid="topbar-date">{{ today }}</span>
          <LocaleSwitcher />
          <ThemeSwitcher />
          <NotificationsBell />
          <!-- v8: the avatar opens the person's own profile (every staff role has one). -->
          <RouterLink
            v-if="userName"
            :to="{ name: 'staff-profile' }"
            class="topbar__avatar"
            :title="userName"
            :aria-label="t('nav.staff.profile')"
            data-testid="topbar-avatar"
          >
            {{ userInitials }}
          </RouterLink>
        </div>
      </header>

      <main class="shell__main">
        <BotNotificationsReminder />
        <!-- A failing page keeps the sidebar and top bar; only the content shows the error. -->
        <AppErrorBoundary :reset-key="route.fullPath">
          <RouterView v-slot="{ Component, route: current }">
            <component :is="Component" :key="current.path" />
          </RouterView>
        </AppErrorBoundary>
      </main>
    </div>

    <AppDrawer
      v-model="menuOpen"
      side="left"
      flush
      width="min(300px, 86vw)"
      :title="t('nav.ariaLabel')"
    >
      <SidebarContent @navigate="menuOpen = false" />
    </AppDrawer>

    <CommandPalette />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  align-items: flex-start;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--page);
  /* v8 sets 1.45 on the whole layout. */
  line-height: 1.45;
}

.shell__sidebar {
  position: sticky;
  top: 0;
  flex: none;
  width: var(--sidebar-w);
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  background: var(--side-bg);
  scrollbar-width: thin;
  scrollbar-color: var(--side-line) transparent;
}

/* The column fills the window and the work area takes the rest under the top bar, so a page-level
   state (loading, empty, error) can sit in the middle of the screen instead of under the bar. */
.shell__column {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
  min-height: 100dvh;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: 16px;
  /* Inside a full-screen Telegram Mini App the bar starts under Telegram's own controls: the
     safe area is added to its height, so its tools never sit under them (0 everywhere else). */
  min-height: calc(var(--topbar-h) + var(--safe-top, 0px));
  padding: var(--safe-top, 0px) 32px 0;
  background: var(--w);
  border-bottom: 1px solid var(--e8);
}

.crumb {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: var(--fs-small);
}

.crumb__root,
.crumb__sep {
  color: var(--t2);
}

.crumb__sep {
  display: flex;
}

.crumb__root:hover {
  color: var(--ink);
}

.crumb__page {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}

.topbar__spacer {
  flex: 1;
}

.topbar__tools {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 22px;
  min-width: 0;
}

.topbar__date {
  flex: none;
  font-size: var(--fs-meta);
  white-space: nowrap;
  color: var(--t2);
}

.topbar__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
  font-weight: 600;
}

/* Narrower desktops: the date goes first, then the gaps tighten. */
@media (max-width: 1180px) {
  .topbar__date {
    display: none;
  }

  .topbar__tools {
    gap: 12px;
  }
}

/* Doubled selector: must beat AppButton's own `display` regardless of stylesheet order. */
.topbar .topbar__menu {
  display: none;
}

.shell__main {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--gap-block);
  /* v8 lets the work area fill the window (main is width:100% with 32px padding, no cap). */
  width: 100%;
  /* The last control of a page stays above the phone's home indicator. */
  padding: var(--page-pad-top) var(--page-pad-x)
    calc(var(--page-pad-bottom) + var(--safe-bottom, 0px));
  min-width: 0;
}

/* Phones (the app also runs inside Telegram): the sidebar moves into a drawer. */
@media (max-width: 880px) {
  .shell__sidebar {
    display: none;
  }

  .topbar {
    min-height: calc(56px + var(--safe-top, 0px));
    padding: calc(8px + var(--safe-top, 0px)) 16px 8px;
  }

  .crumb {
    display: none;
  }

  .topbar .topbar__menu {
    display: inline-flex;
  }

  .topbar__spacer {
    display: none;
  }

  .topbar__tools {
    flex: 1;
    gap: 8px;
  }

  /* The search takes the room the hidden breadcrumb leaves. */
  .topbar__tools :deep(.search) {
    flex: 1 1 auto;
  }
}

/* Tablets held in the hand: the avatar is a link, so it gets a full touch target. */
@media (pointer: coarse), (hover: none) {
  .topbar__avatar {
    width: 44px;
    height: 44px;
  }
}

/* Phones: the avatar repeats the user block of the menu drawer, so it gives its room to search. */
@media (max-width: 480px) {
  .topbar__avatar {
    display: none;
  }
}
</style>
