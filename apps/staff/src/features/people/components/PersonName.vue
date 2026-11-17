<script lang="ts">
import { ref } from 'vue';
import type { StaffPersonCard, StaffRole } from '@iorder/shared';

// One card at a time across the whole page, and one read per person: a table repeats the same names.
const openCardOwner = ref<symbol | null>(null);
const cardCache = new Map<string, StaffPersonCard>();
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiResponseError } from '@core/lib/api-errors';
import { useServices } from '@/app/services';
import type { PersonRef } from '../api/people-api';
import { placeCard } from '../domain/card-position';

const props = defineProps<{
  name: string;
  userId?: string | null;
  telegramUserId?: string | null;
}>();

const OPEN_DELAY_MS = 250;
// Long enough to move the pointer from the name onto the card (to copy the phone number).
const CLOSE_DELAY_MS = 150;
const CARD_ROLES: readonly StaffRole[] = ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'];

const { t } = useI18n();
const { peopleApi, currentUser } = useServices();

const person = computed<PersonRef | null>(() => {
  if (props.userId) return { userId: props.userId };
  if (props.telegramUserId) return { telegramUserId: props.telegramUserId };
  return null;
});
// UI convenience only: the api refuses the card to everybody else. The warehouse and the driver
// see plain names, the same as before.
const enabled = computed(
  () =>
    person.value !== null &&
    (currentUser.user.value?.staffRoles ?? []).some((role) => CARD_ROLES.includes(role)),
);

const owner = Symbol('person-card');
const isOpen = computed(() => openCardOwner.value === owner);
const cardEl = ref<HTMLElement | null>(null);
const nameEl = ref<HTMLElement | null>(null);
// Inside a link or a button the parent already takes the focus: two nested tab stops are invalid.
const focusable = ref(true);
onMounted(() => {
  focusable.value = !nameEl.value?.parentElement?.closest('a, button');
});
const position = ref({ left: 0, top: 0 });
const card = ref<StaffPersonCard | null>(null);
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading');

let pointer = { x: 0, y: 0 };
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const roleLine = computed(() => {
  if (!card.value) return '';
  const roles = card.value.staffRoles.map((role) => t(`roles.staff.${role}`));
  const membership = card.value.membership;
  if (membership) roles.push(t(`roles.organization.${membership.role}`));
  return roles.length > 0 ? roles.join(', ') : t('people.card.noRole');
});

async function place(): Promise<void> {
  await nextTick();
  const el = cardEl.value;
  if (!el) return;
  position.value = placeCard({
    pointer,
    card: { width: el.offsetWidth, height: el.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
}

async function load(target: PersonRef): Promise<void> {
  const key = target.userId ?? `telegram:${target.telegramUserId}`;
  const cached = cardCache.get(key);
  if (cached) {
    card.value = cached;
    state.value = 'ready';
    return;
  }
  state.value = 'loading';
  try {
    const answer = await peopleApi.card(target);
    cardCache.set(key, answer);
    card.value = answer;
    state.value = 'ready';
  } catch (error) {
    state.value = error instanceof ApiResponseError && error.status === 404 ? 'missing' : 'error';
  }
  // The content changed its height: stay inside the window.
  if (isOpen.value) void place();
}

function cancelTimers(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

function open(): void {
  if (!person.value) return;
  openCardOwner.value = owner;
  void place();
  void load(person.value);
}

function close(): void {
  cancelTimers();
  if (isOpen.value) openCardOwner.value = null;
}

function onPointerEnter(event: PointerEvent): void {
  // A hover card has no meaning on a touch screen, where it would only get in the way of a tap.
  if (event.pointerType !== 'mouse' || !enabled.value) return;
  cancelTimers();
  pointer = { x: event.clientX, y: event.clientY };
  openTimer = setTimeout(open, OPEN_DELAY_MS);
}

function onPointerMove(event: PointerEvent): void {
  if (!isOpen.value) pointer = { x: event.clientX, y: event.clientY };
}

function onPointerLeave(): void {
  cancelTimers();
  closeTimer = setTimeout(close, CLOSE_DELAY_MS);
}

function onFocus(event: FocusEvent): void {
  const el = event.target as HTMLElement;
  if (!enabled.value || !el.matches(':focus-visible')) return;
  const rect = el.getBoundingClientRect();
  pointer = { x: rect.left, y: rect.bottom };
  open();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isOpen.value) {
    event.stopPropagation();
    close();
  }
}

// The card is fixed to the window, so a scroll would leave it next to the wrong row.
watch(isOpen, (now) => {
  if (now) window.addEventListener('scroll', close, true);
  else window.removeEventListener('scroll', close, true);
});

onBeforeUnmount(() => {
  close();
  window.removeEventListener('scroll', close, true);
});
</script>

<template>
  <span
    v-if="enabled"
    ref="nameEl"
    class="person-name"
    :tabindex="focusable ? 0 : undefined"
    data-testid="person-name"
    @pointerenter="onPointerEnter"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @focus="onFocus"
    @blur="close"
    @keydown="onKeydown"
    >{{ name }}</span
  >
  <span v-else>{{ name }}</span>
  <Teleport v-if="enabled" to="body">
    <div
      v-if="isOpen"
      ref="cardEl"
      class="card"
      role="tooltip"
      data-testid="person-card"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @pointerenter="cancelTimers"
      @pointerleave="onPointerLeave"
    >
      <template v-if="state === 'ready' && card">
        <b class="card__name">{{ card.fullName }}</b>
        <span class="card__role">{{ roleLine }}</span>
        <span v-if="card.membership" class="card__org">{{ card.membership.organizationName }}</span>
        <a v-if="card.phone" class="card__phone" :href="`tel:${card.phone}`">{{ card.phone }}</a>
        <span v-else class="card__muted">{{ t('people.card.noPhone') }}</span>
        <span v-if="card.status === 'BLOCKED'" class="card__blocked">{{
          t('people.card.blocked')
        }}</span>
      </template>
      <template v-else>
        <b class="card__name">{{ name }}</b>
        <span class="card__muted">{{
          state === 'loading'
            ? t('people.card.loading')
            : state === 'missing'
              ? t('people.card.notInSystem')
              : t('people.card.error')
        }}</span>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.person-name {
  cursor: help;
  border-radius: 2px;
  text-decoration: underline dotted transparent;
  text-underline-offset: 3px;
}

.person-name:hover,
.person-name:focus-visible {
  text-decoration-color: currentColor;
}

.person-name:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.card {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 260px;
  max-width: calc(100vw - 16px);
  padding: 12px 14px;
  background: var(--w);
  border-radius: var(--r-card);
  box-shadow:
    inset 0 0 0 1px var(--e8),
    var(--sh-dropdown);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
  text-align: left;
  animation: popIn 0.14s ease-out both;
}

.card__name {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.card__role,
.card__org,
.card__muted {
  color: var(--t2);
}

.card__phone {
  color: var(--acc-fg);
  font-variant-numeric: tabular-nums;
  text-decoration: none;
}

.card__phone:hover {
  text-decoration: underline;
}

.card__blocked {
  color: var(--red, var(--t2));
  font-weight: 600;
}
</style>
