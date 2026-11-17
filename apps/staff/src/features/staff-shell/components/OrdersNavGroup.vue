<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { parseOrderFilters } from '@/features/staff-orders/domain/order-filters';
import { useSessionFlag } from '../composables/use-session-flag';
import type { OrdersNavChild } from '../nav-config';
import { activeOrdersChild, isOrdersGroupActive } from '../orders-nav-state';

const props = defineProps<{ children: readonly OrdersNavChild[] }>();
const emit = defineEmits<{ navigate: [] }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { awaitingApproval, dashboardSummaryStore } = useServices();

const listId = useId();
const expanded = useSessionFlag('iorder.nav.ordersGroupOpen', true);

// Numbers never block the menu: until a source has answered there is simply no badge.
function countOf(child: OrdersNavChild): number | null {
  if (child.key === 'awaitingManager') return awaitingApproval.count.value;
  const queue = child.queue;
  if (!queue) return null;
  return dashboardSummaryStore.summary.value?.queues.find((q) => q.key === queue)?.count ?? null;
}

const filters = computed(() => parseOrderFilters(route.query));
const current = computed(() =>
  activeOrdersChild(props.children, {
    name: typeof route.name === 'string' ? route.name : null,
    stage: filters.value.stage,
    period: filters.value.period,
  }),
);
const groupActive = computed(() =>
  isOrdersGroupActive(props.children, typeof route.name === 'string' ? route.name : null),
);

const rows = computed(() =>
  props.children.map((child) => ({
    child,
    to: { name: child.routeName, query: child.query ? { ...child.query } : {} },
    active: current.value?.key === child.key,
    count: countOf(child),
  })),
);

// Collapsed, the count of the own step stays visible on the label so waiting work is not hidden.
const collapsedCount = computed(() => {
  const own = rows.value.find((row) => row.child.key !== 'all');
  return own?.count ?? null;
});

// The label opens the default child (the first one) and unfolds the group.
function openDefault(): void {
  const first = rows.value[0];
  if (!first) return;
  expanded.value = true;
  void router.push(first.to);
  emit('navigate');
}
</script>

<template>
  <div class="og">
    <div
      class="og__head"
      :class="{ 'og__head--active': groupActive, 'og__head--folded': !expanded }"
    >
      <button
        type="button"
        class="og__label"
        :aria-current="groupActive && !current ? 'true' : undefined"
        data-testid="orders-group-label"
        @click="openDefault"
      >
        <StaffIcon name="bag" class="og__icon" />
        <span class="og__text">{{ t('nav.ordersGroup.label') }}</span>
        <span
          v-if="!expanded && collapsedCount !== null && collapsedCount > 0"
          class="og__badge"
          :aria-label="t('nav.ordersGroup.badge', { count: collapsedCount })"
          data-testid="orders-group-badge"
        >
          {{ collapsedCount }}
        </span>
      </button>
      <button
        type="button"
        class="og__toggle"
        :aria-expanded="expanded"
        :aria-controls="listId"
        :aria-label="t('nav.ordersGroup.toggle')"
        data-testid="orders-group-toggle"
        @click="expanded = !expanded"
      >
        <StaffIcon
          name="down"
          :size="14"
          class="og__chevron"
          :class="{ 'og__chevron--open': expanded }"
        />
      </button>
    </div>

    <ul v-show="expanded" :id="listId" class="og__list">
      <li v-for="row in rows" :key="row.child.key">
        <RouterLink v-slot="{ href, navigate }" :to="row.to" custom>
          <a
            :href="href"
            class="og__item"
            :class="{ 'og__item--active': row.active }"
            :aria-current="row.active ? 'page' : undefined"
            :data-testid="`orders-nav-${row.child.key}`"
            @click="
              (event) => {
                navigate(event);
                emit('navigate');
              }
            "
          >
            <span>{{ t(row.child.labelKey) }}</span>
            <span
              v-if="row.count !== null && row.count > 0"
              class="og__badge"
              :class="{ 'og__badge--on': row.active }"
              :aria-label="t('nav.ordersGroup.badge', { count: row.count })"
            >
              {{ row.count }}
            </span>
          </a>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Design v8 (dark sidebar): the group reads like a sidebar entry with the bag icon; its children
   hang off a thin line. The group itself is highlighted only while folded, as in v8. */
.og {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.og__head {
  display: flex;
  align-items: center;
  border-radius: var(--r-btn-sm);
  color: var(--side-fg);
}

.og__head:hover {
  color: var(--side-strong);
}

.og__head--active {
  color: var(--side-strong);
}

.og__head--active.og__head--folded {
  background: var(--side-active);
}

.og__icon {
  flex: none;
  color: var(--side-fg);
}

.og__head--active .og__icon {
  color: var(--side-icon-active);
}

.og__label {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  min-height: 43px;
  padding: 0 0 0 12px;
  border: 0;
  background: transparent;
  border-radius: var(--r-btn-sm);
  font: inherit;
  font-size: var(--fs-small);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.og__head--active .og__label {
  font-weight: 600;
}

.og__text {
  flex: 1;
}

.og__toggle {
  display: grid;
  place-items: center;
  width: 36px;
  align-self: stretch;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: var(--r-btn-sm);
  color: var(--side-dim);
  cursor: pointer;
}

.og__toggle:hover {
  color: var(--side-strong);
}

.og__chevron {
  transition: transform 0.2s var(--ease);
}

.og__chevron--open {
  transform: rotate(180deg);
}

.og__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 0 21px;
  padding: 0 0 0 10px;
  border-left: 1px solid var(--side-line);
  list-style: none;
}

.og__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: var(--fs-small);
  color: var(--side-fg);
}

.og__item:hover {
  color: var(--side-strong);
}

.og__item--active {
  background: var(--side-active);
  color: var(--side-strong);
  font-weight: 600;
}

/* Same chip as the plain entries (SidebarContent .nav-badge), orange on the open child. */
.og__badge {
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

.og__badge--on {
  background: var(--side-icon-active);
  color: var(--acc-on);
}

.og__label:focus-visible,
.og__toggle:focus-visible,
.og__item:focus-visible {
  outline: 2px solid var(--side-icon-active);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .og__chevron {
    transition: none;
  }
}

/* Touch devices: 44px hit area. */
@media (pointer: coarse) {
  .og__label,
  .og__toggle,
  .og__item {
    min-height: 44px;
  }
}
</style>
