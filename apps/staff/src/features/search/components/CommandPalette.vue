<script setup lang="ts">
import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import {
  visibleStaffPages,
  staffRouteName,
  type StaffPage,
} from '@/features/staff-shell/nav-config';
import { totalOf, type OrderSummary } from '@/features/staff-orders/domain/order-model';
import { useFormat } from '@core/i18n/use-format';
import {
  buildSearchGroups,
  flattenGroups,
  type SearchItem,
  type SearchLabels,
  type SearchSources,
} from '../domain/search-groups';

const { t } = useI18n();
const router = useRouter();
const { commandPalette, currentUser, ordersApi, ordersStore, directoryStore, catalogApi } =
  useServices();
const { formatMoney, formatShortDateTime } = useFormat();

const query = ref('');
const activeIndex = ref(0);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const listId = useId();
const open = computed(() => commandPalette.isOpen.value);

// Products are loaded the first time the palette opens (the staff product list is small).
const products = shallowRef<readonly StaffProductDetailResponse[] | null>(null);
async function ensureProducts(): Promise<void> {
  if (products.value) return;
  try {
    products.value = (await catalogApi.listProducts()).items;
  } catch {
    products.value = [];
  }
}

// Orders are searched on the server (number, organization, person): the browser holds no history.
// Without a query the manager's queue the shell keeps is offered.
const ORDER_RESULTS = 5;
const ORDER_SEARCH_PAUSE_MS = 250;
const foundOrders = shallowRef<readonly OrderSummary[]>([]);
let searchRun = 0;
let searchPause: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
  clearTimeout(searchPause);
  const text = value.trim();
  const mine = ++searchRun;
  if (text === '' || !can('orders')) {
    foundOrders.value = [];
    return;
  }
  searchPause = setTimeout(() => {
    ordersApi
      .listOrders({ search: text, limit: ORDER_RESULTS })
      .then((page) => {
        if (mine === searchRun) foundOrders.value = page.orders;
      })
      .catch(() => {
        if (mine === searchRun) foundOrders.value = [];
      });
  }, ORDER_SEARCH_PAUSE_MS);
});
onBeforeUnmount(() => clearTimeout(searchPause));

const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const pages = computed<readonly StaffPage[]>(() => visibleStaffPages(roles.value));
const can = (key: string): boolean => pages.value.some((p) => p.key === key);

const sources = computed<SearchSources>(() => ({
  pages: pages.value.map((p) => ({
    key: p.key,
    label: t(p.labelKey),
    to: { name: staffRouteName(p) },
  })),
  orders: can('orders')
    ? query.value.trim() === ''
      ? ordersStore.orders.value
      : foundOrders.value
    : null,
  organizations: can('customers') ? directoryStore.organizations.value : null,
  members: can('customers') ? directoryStore.members.value : null,
  products: can('prices') ? products.value : null,
}));

const labels = computed<SearchLabels>(() => ({
  pageSubtitle: t('search.goToPage'),
  orderSubtitle: (order) =>
    [
      t(`orders.stages.${order.status}`),
      totalOf(order) === null
        ? null
        : `${formatMoney(totalOf(order) ?? '0')} ${t('common.currency')}`,
      formatShortDateTime(order.submittedAt),
    ]
      .filter((part) => part !== null)
      .join(' · '),
  memberSubtitle: (member, organization) =>
    `${organization?.name ?? ''} · ${t(`roles.organization.${member.role}`)}`,
  productTitle: (product) => product.name,
  productSubtitle: (product) => product.productCode,
}));

const groups = computed(() => buildSearchGroups(query.value, sources.value, labels.value));
const flat = computed(() => flattenGroups(groups.value));
const empty = computed(() => flat.value.length === 0);
// The active row can never point past the end when the results shrink.
const active = computed(() => Math.min(activeIndex.value, Math.max(0, flat.value.length - 1)));
const optionId = (item: SearchItem): string => `${listId}-${item.id}`;
const activeOptionId = computed(() => {
  const item = flat.value[active.value];
  return item ? optionId(item) : undefined;
});

watch(open, async (isOpen) => {
  if (!isOpen) return;
  query.value = '';
  activeIndex.value = 0;
  void ensureProducts();
  await nextTick();
  input.value?.focus();
});

watch(query, () => {
  activeIndex.value = 0;
});

useDialogFocus({ active: open, container: panel, onEscape: () => commandPalette.close() });

function choose(item: SearchItem | undefined): void {
  if (!item) return;
  commandPalette.close();
  void router.push(item.to);
}

function onKeydown(event: KeyboardEvent): void {
  // Enter that confirms an IME composition (Japanese, Chinese, ...) is not "open the result".
  if (event.isComposing) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex.value = Math.min(active.value + 1, flat.value.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex.value = Math.max(active.value - 1, 0);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    choose(flat.value[active.value]);
  }
}

watch(active, async () => {
  await nextTick();
  panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
});

const indexOf = (item: SearchItem): number => flat.value.findIndex((i) => i.id === item.id);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cmd" data-testid="command-palette">
      <div class="cmd__overlay" @click="commandPalette.close()" />
      <div
        ref="panel"
        class="cmd__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('search.dialogLabel')"
        tabindex="-1"
      >
        <div class="cmd__head">
          <svg
            class="cmd__icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref="input"
            v-model="query"
            class="cmd__input"
            type="text"
            role="combobox"
            autocomplete="off"
            spellcheck="false"
            aria-expanded="true"
            :aria-controls="listId"
            :aria-activedescendant="activeOptionId"
            :placeholder="t('search.placeholder')"
            :aria-label="t('search.dialogLabel')"
            @keydown="onKeydown"
          />
          <kbd class="cmd__esc" @click="commandPalette.close()">{{ 'Esc' }}</kbd>
        </div>

        <div :id="listId" class="cmd__body" role="listbox" :aria-label="t('search.dialogLabel')">
          <div
            v-for="group in groups"
            :key="group.key"
            class="cmd__group"
            role="group"
            :aria-label="t(`search.groups.${group.key}`)"
          >
            <span class="cmd__title">{{ t(`search.groups.${group.key}`) }}</span>
            <button
              v-for="item in group.items"
              :id="optionId(item)"
              :key="item.id"
              type="button"
              role="option"
              class="cmd__item"
              :class="{ 'cmd__item--on': indexOf(item) === active }"
              :aria-selected="indexOf(item) === active"
              tabindex="-1"
              @click="choose(item)"
              @mouseenter="activeIndex = indexOf(item)"
            >
              <span class="cmd__ic" :class="`cmd__ic--${item.tone}`" aria-hidden="true">{{
                item.icon
              }}</span>
              <span class="cmd__text">
                <span class="cmd__name">{{ item.title }}</span>
                <span class="cmd__sub">{{ item.subtitle }}</span>
              </span>
              <span class="cmd__enter" aria-hidden="true">{{ '↵' }}</span>
            </button>
          </div>
          <p v-if="empty" class="cmd__empty" role="status">{{ t('search.empty', { query }) }}</p>
        </div>

        <div class="cmd__foot">
          <span>{{ t('search.hints.move') }}</span>
          <span>{{ t('search.hints.open') }}</span>
          <span>{{ t('search.hints.close') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmd {
  position: fixed;
  inset: 0;
  z-index: var(--z-cmdk);
  display: flex;
  /* Anchored near the top, not centred: the panel grows and shrinks with the result count and a
     centred one would move up and down under the pointer while typing. */
  align-items: flex-start;
  justify-content: center;
  padding: calc(max(16px, 12vh) + var(--safe-top, 0px)) 16px calc(16px + var(--safe-bottom, 0px));
}

.cmd__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-modal);
  animation: fadeIn 0.18s ease both;
}

.cmd__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(560px, 86vh);
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--float-ring),
    var(--sh-cmdk);
  animation: modalIn 0.24s var(--ease) both;
  outline: none;
}

.cmd__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--e8);
}

.cmd__icon {
  flex: none;
  color: var(--t2);
}

.cmd__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 17px;
}

.cmd__input:focus-visible {
  outline: none;
}

.cmd__esc {
  padding: 3px 7px;
  background: var(--f5);
  cursor: pointer;
}

.cmd__body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.cmd__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
}

.cmd__title {
  padding: 4px 10px;
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--t3);
}

.cmd__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 0;
  border-radius: var(--r-input);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.cmd__item--on {
  background: var(--f5);
}

.cmd__ic {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-meta);
  font-weight: 700;
}

.cmd__ic--accent {
  background: var(--acc-bg);
  color: var(--acc-fg);
}
.cmd__ic--sand {
  background: var(--beige);
  color: var(--ink);
}
.cmd__ic--plain {
  background: var(--ef);
  color: var(--ink);
}
.cmd__ic--muted {
  background: var(--f5);
  color: var(--ink);
}
.cmd__ic--dark {
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.cmd__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cmd__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.cmd__sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  color: var(--t3);
}

.cmd__enter {
  font-size: var(--fs-meta);
  color: var(--t3);
  opacity: 0;
}

.cmd__item--on .cmd__enter {
  opacity: 1;
}

.cmd__empty {
  margin: 0;
  padding: 40px 16px;
  font-size: var(--fs-body);
  color: var(--t3);
  text-align: center;
}

.cmd__foot {
  display: flex;
  gap: 16px;
  padding: 10px 18px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-meta);
  color: var(--t3);
}

@media (pointer: coarse) {
  .cmd__item {
    min-height: 44px;
  }
}
</style>
