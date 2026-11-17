<script setup lang="ts">
import type { MarkedOrderNotification } from '@iorder/shared/staff-auth';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import {
  hasUnread,
  readSeenAt,
  writeSeenAt,
} from '@/features/staff-notifications/domain/marked-orders-seen';

// Design v8 top bar bell. Only the purchasing manager has a feed (orders with marked goods, [C]
// 2026-10-31); order updates reach the other roles through the Telegram bot, so their panel shows
// its empty state.
const REFRESH_MS = 60_000;

const { t, locale } = useI18n();
const { formatNumber } = useFormat();
const { staffNotificationsApi, currentUser } = useServices();

const open = ref(false);
const userId = computed(() => currentUser.user.value?.id ?? null);
const hasFeed = computed(
  () => currentUser.user.value?.staffRoles.includes('PURCHASING_MANAGER') === true,
);
const items = ref<readonly MarkedOrderNotification[]>([]);
const loaded = ref(false);
const failed = ref(false);
const seenAt = ref<string | null>(null);
const unread = computed(() => hasUnread(items.value, seenAt.value));
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  if (!hasFeed.value) return;
  try {
    items.value = (await staffNotificationsApi.markedOrders()).items;
    failed.value = false;
    if (open.value) markSeen();
  } catch {
    // Old items stay on screen; the message says they may be out of date.
    failed.value = true;
  } finally {
    loaded.value = true;
  }
}

function markSeen(): void {
  const newest = items.value[0]?.createdAt;
  if (newest === undefined || userId.value === null) return;
  seenAt.value = newest;
  writeSeenAt(userId.value, newest);
}

const formatTime = (iso: string): string =>
  new Intl.DateTimeFormat(locale.value, {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

watch(
  [hasFeed, userId],
  () => {
    clearInterval(timer);
    timer = undefined;
    if (!hasFeed.value || userId.value === null) return;
    seenAt.value = readSeenAt(userId.value);
    void load();
    timer = setInterval(() => void load(), REFRESH_MS);
  },
  { immediate: true },
);

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelId = useId();
const titleId = useId();

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    markSeen();
    void load();
    await nextTick();
    panel.value?.focus();
  }
}

function close(returnFocus: boolean): void {
  open.value = false;
  if (returnFocus) trigger.value?.focus();
}

function onPointerDown(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) close(false);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation();
    close(true);
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKeydown);
  clearInterval(timer);
});
</script>

<template>
  <div ref="root" class="bell">
    <button
      ref="trigger"
      type="button"
      class="bell__button"
      :class="{ 'bell__button--open': open }"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? panelId : undefined"
      :aria-label="t('nav.notifications.label')"
      data-testid="notifications-bell"
      @click="toggle"
    >
      <StaffIcon name="bell" :size="18" />
      <span v-if="unread" class="bell__dot" data-testid="notifications-unread" />
    </button>
    <div
      v-if="open"
      :id="panelId"
      ref="panel"
      class="bell__panel"
      role="dialog"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <p :id="titleId" class="bell__title">{{ t('nav.notifications.label') }}</p>
      <p v-if="hasFeed && failed" class="bell__state" role="alert">
        {{ t('nav.notifications.marked.error') }}
      </p>
      <p v-if="hasFeed && !loaded" class="bell__state" role="status">
        {{ t('nav.notifications.marked.loading') }}
      </p>
      <ul v-else-if="items.length > 0" class="bell__list" data-testid="marked-orders">
        <li v-for="item in items" :key="item.id">
          <RouterLink
            class="bell__item"
            :to="{ name: 'staff-order', params: { orderId: item.orderId } }"
            @click="close(false)"
          >
            <span class="bell__item-title">
              {{ t(`nav.notifications.marked.${item.type}`, { number: item.orderNumber }) }}
            </span>
            <span v-for="line in item.lines" :key="line.productCode" class="bell__item-line">
              {{ line.name }} ·
              {{ t('nav.notifications.marked.quantity', { count: formatNumber(line.quantity) }) }}
            </span>
            <time class="bell__item-time" :datetime="item.createdAt">
              {{ formatTime(item.createdAt) }}
            </time>
          </RouterLink>
        </li>
      </ul>
      <div v-else-if="!failed" class="bell__empty" role="status">
        <span class="bell__tile" aria-hidden="true">
          <StaffIcon name="bell" :size="18" />
        </span>
        <span class="bell__empty-title">{{ t('nav.notifications.empty') }}</span>
        <span class="bell__empty-hint">
          {{ hasFeed ? t('nav.notifications.marked.emptyHint') : t('nav.notifications.emptyHint') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bell {
  position: relative;
  flex: none;
}

/* v8 draws a bare 18px icon; the 34px box gives it the same hit area as its neighbours. */
.bell__button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.bell__button:hover,
.bell__button--open {
  background: var(--f5);
  color: var(--ink);
}

.bell__panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: var(--z-dropdown);
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow:
    inset 0 0 0 1px var(--e8),
    var(--sh-dropdown);
  animation: popIn 0.16s ease-out both;
  outline: none;
}

.bell__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.bell__button {
  position: relative;
}

.bell__dot {
  position: absolute;
  top: 6px;
  right: 7px;
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--red);
}

.bell__state {
  margin: 0;
  padding: 8px 0;
  font-size: 13px;
  color: var(--t2);
}

.bell__list {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  margin: 4px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.bell__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-radius: var(--r-card);
  color: inherit;
  text-decoration: none;
}

.bell__item:hover {
  background: var(--e8);
}

.bell__item-title {
  font-size: 13px;
  font-weight: 600;
}

.bell__item-line,
.bell__item-time {
  font-size: 12px;
  color: var(--t2);
}

.bell__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 8px 8px;
  text-align: center;
}

.bell__tile {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border-radius: var(--r-row);
  background: var(--ef);
  color: var(--t2);
}

.bell__empty-title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.bell__empty-hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (pointer: coarse), (hover: none) {
  .bell__button {
    width: 44px;
    height: 44px;
  }
}

@media (max-width: 480px) {
  /* Anchored to the screen, not the bell, so it never runs off the left edge. */
  .bell__panel {
    position: fixed;
    /* Under the top bar, which is taller by the safe area inside Telegram. */
    top: calc(64px + var(--safe-top, 0px));
    right: 16px;
    left: 16px;
    width: auto;
    max-width: none;
  }
}
</style>
