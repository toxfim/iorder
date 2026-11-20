<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ORGANIZATION_LABELS, type OrganizationLabel, type OrganizationType } from '@iorder/shared';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useDelayedPresence } from '@core/composables/use-delayed-presence';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import { EXIT_MS } from '@core/components/ui/motion';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { formatPhone } from '@core/lib/phone';
import { implicitMember } from '../domain/new-order';
import OrganizationTags from './OrganizationTags.vue';

// Step 1 of the manager's new order (approved design «02-yangi-buyurtma», a dialog over the orders
// list): who the order is for. A quick search over every customer (name, phone, organization), the
// recent customers, then a type: an individual is chosen at once; a group opens its members, and
// the order is placed in the chosen member's name. The server checks the member again.
const props = defineProps<{
  modelValue: boolean;
  /** Why the manager is back here: the server refused the earlier customer. */
  notice?: string | null;
  /** The customer already in the draft (coming back with "O'zgartirish"). */
  initialCustomer: NewOrderCustomer | null;
  initialMember: NewOrderCustomerMember | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  chosen: [customer: NewOrderCustomer, member: NewOrderCustomerMember];
}>();

const { t } = useI18n();
const { ordersApi } = useServices();
const titleId = useId();
const subtitleId = useId();
const panel = ref<HTMLElement | null>(null);
const open = computed(() => props.modelValue);
const { mounted, closing } = useDelayedPresence(open, EXIT_MS);

function close(): void {
  emit('update:modelValue', false);
}
useDialogFocus({ active: open, container: panel, onEscape: close });

type View = 'types' | 'list' | 'members';
const view = ref<View>('types');
const listType = ref<OrganizationType>('GROUP');
const quick = ref('');
const listSearch = ref('');
const label = ref<OrganizationLabel | null>(null);
const group = ref<NewOrderCustomer | null>(null);
const picked = ref<NewOrderCustomer | null>(null);
const pickedMember = ref<NewOrderCustomerMember | null>(null);

type LoadState = 'loading' | 'ready' | 'error' | 'denied';
const quickResults = ref<NewOrderCustomer[]>([]);
const listResults = ref<NewOrderCustomer[]>([]);
const recent = ref<NewOrderCustomer[]>([]);
const quickState = ref<LoadState>('ready');
const listState = ref<LoadState>('loading');

// A late answer of an older search never overwrites a newer one.
let quickSeq = 0;
let listSeq = 0;

function stateOf(error: unknown): LoadState {
  return error instanceof PermissionDeniedError ? 'denied' : 'error';
}

async function loadQuick(): Promise<void> {
  const text = quick.value.trim();
  const seq = (quickSeq += 1);
  if (text === '') {
    quickResults.value = [];
    quickState.value = 'ready';
    return;
  }
  quickState.value = 'loading';
  try {
    const answer = await ordersApi.listNewOrderCustomers({ search: text });
    if (seq !== quickSeq) return;
    quickResults.value = answer.items;
    quickState.value = 'ready';
  } catch (error) {
    if (seq === quickSeq) quickState.value = stateOf(error);
  }
}

async function loadList(): Promise<void> {
  const seq = (listSeq += 1);
  listState.value = 'loading';
  try {
    const text = listSearch.value.trim();
    const answer = await ordersApi.listNewOrderCustomers({
      type: listType.value,
      ...(text === '' ? {} : { search: text }),
      ...(label.value === null ? {} : { label: label.value }),
    });
    if (seq !== listSeq) return;
    listResults.value = answer.items;
    recent.value = answer.recent;
    listState.value = 'ready';
  } catch (error) {
    if (seq === listSeq) listState.value = stateOf(error);
  }
}

async function loadRecent(): Promise<void> {
  try {
    recent.value = (await ordersApi.listNewOrderCustomers({})).recent;
  } catch (error) {
    // The chips are a shortcut; without them the search and the types still work.
    if (error instanceof PermissionDeniedError) listState.value = 'denied';
  }
}

const PAUSE_MS = 250;
let quickPause: ReturnType<typeof setTimeout> | undefined;
let listPause: ReturnType<typeof setTimeout> | undefined;
watch(quick, () => {
  clearTimeout(quickPause);
  quickPause = setTimeout(() => void loadQuick(), PAUSE_MS);
});
watch(listSearch, () => {
  clearTimeout(listPause);
  listPause = setTimeout(() => void loadList(), PAUSE_MS);
});
watch(label, () => void loadList());
onBeforeUnmount(() => {
  clearTimeout(quickPause);
  clearTimeout(listPause);
});

// Every opening starts at the types, with what the draft already holds.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    view.value = 'types';
    quick.value = '';
    listSearch.value = '';
    label.value = null;
    group.value = null;
    picked.value = props.initialCustomer;
    pickedMember.value = props.initialMember;
    quickResults.value = [];
    void loadRecent();
  },
  { immediate: true },
);

function openList(type: OrganizationType): void {
  listType.value = type;
  listSearch.value = '';
  label.value = null;
  view.value = 'list';
  void loadList();
}

/** A person is chosen at once; a group opens its members first. */
function choose(customer: NewOrderCustomer): void {
  const only = implicitMember(customer);
  if (customer.type === 'PERSON' && only) {
    picked.value = customer;
    pickedMember.value = only;
    return;
  }
  group.value = customer;
  picked.value = customer;
  pickedMember.value = null;
  quick.value = '';
  view.value = 'members';
}

/** «Savatga →» on a quick result: an individual goes straight to the products. */
function quickPick(customer: NewOrderCustomer): void {
  choose(customer);
  if (pickedMember.value !== null) next();
}

function pickMember(member: NewOrderCustomerMember): void {
  pickedMember.value = member;
}

const ready = computed(() => picked.value !== null && pickedMember.value !== null);

function next(): void {
  if (picked.value === null || pickedMember.value === null) return;
  emit('chosen', picked.value, pickedMember.value);
}

const labelOptions = computed(() => [null, ...ORGANIZATION_LABELS] as const);
const labelText = (value: OrganizationLabel | null): string =>
  value === null ? t('orders.newOrder.customer.allLabels') : t(`orders.clientTags.labels.${value}`);

function subtitleOf(customer: NewOrderCustomer): string {
  if (customer.type === 'GROUP') {
    return `${t('orders.newOrder.customer.group')} · ${t('orders.newOrder.customer.members', { count: customer.members.length })}`;
  }
  const phone = customer.members[0]?.phone;
  return [phone ? formatPhone(phone) : null, t('orders.newOrder.customer.person')]
    .filter(Boolean)
    .join(' · ');
}

const pickedLine = computed(() => {
  const member = pickedMember.value;
  if (!member) return '';
  return [member.fullName, member.phone ? formatPhone(member.phone) : null]
    .filter(Boolean)
    .join(' · ');
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="mounted"
      class="nod"
      :class="{ 'nod--closing': closing }"
      data-testid="new-order-customer-dialog"
    >
      <div class="nod__overlay" @click="close" />
      <div
        ref="panel"
        class="nod__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="subtitleId"
        tabindex="-1"
      >
        <header class="nod__head">
          <div>
            <h2 :id="titleId" class="nod__title">{{ t('orders.newOrder.title') }}</h2>
            <p :id="subtitleId" class="nod__sub">{{ t('orders.newOrder.customer.subtitle') }}</p>
          </div>
          <button
            type="button"
            class="nod__x"
            :aria-label="t('orders.newOrder.close')"
            data-testid="new-order-close"
            @click="close"
          >
            <StaffIcon name="x" :size="16" />
          </button>
        </header>

        <div class="nod__body">
          <p v-if="notice" class="nod__alert" role="alert" data-testid="new-order-notice">
            {{ notice }}
          </p>
          <p v-if="listState === 'denied'" class="nod__note" role="alert">
            {{ t('orders.newOrder.denied') }}
          </p>
          <template v-else>
            <section class="sect">
              <label class="lbl" :for="`${titleId}-q`">{{
                t('orders.newOrder.customer.quickSearch')
              }}</label>
              <div class="field">
                <StaffIcon name="search" :size="16" />
                <input
                  :id="`${titleId}-q`"
                  v-model="quick"
                  type="search"
                  autocomplete="off"
                  maxlength="100"
                  :placeholder="t('orders.newOrder.customer.searchPlaceholder')"
                  data-testid="new-order-quick-search"
                />
              </div>
              <div v-if="quick.trim() !== ''" class="results" data-testid="quick-results">
                <p v-if="quickState === 'loading'" class="muted" role="status">
                  {{ t('orders.newOrder.customer.loading') }}
                </p>
                <p v-else-if="quickState === 'error'" class="muted" role="alert">
                  {{ t('orders.newOrder.customer.error') }}
                  <button type="button" class="link" @click="loadQuick">
                    {{ t('orders.newOrder.customer.retry') }}
                  </button>
                </p>
                <p v-else-if="quickResults.length === 0" class="muted" role="status">
                  {{ t('orders.newOrder.customer.empty') }}
                </p>
                <button
                  v-for="customer in quickResults"
                  :key="customer.organizationId"
                  type="button"
                  class="res"
                  data-testid="quick-result"
                  @click="quickPick(customer)"
                >
                  <span class="res__who">
                    <b>{{ customer.name }}</b>
                    <small>{{ subtitleOf(customer) }}</small>
                  </span>
                  <OrganizationTags
                    :type="customer.type"
                    :label="customer.label"
                    class="res__tags"
                  />
                  <span class="res__go">
                    {{
                      customer.type === 'PERSON'
                        ? t('orders.newOrder.customer.toCart')
                        : t('orders.newOrder.customer.pickMember')
                    }}
                    <StaffIcon name="arrow" :size="14" />
                  </span>
                </button>
              </div>
            </section>

            <div v-if="recent.length > 0" class="recent">
              <span class="lbl">{{ t('orders.newOrder.customer.recent') }}</span>
              <button
                v-for="customer in recent"
                :key="customer.organizationId"
                type="button"
                class="chip"
                :class="{ 'chip--on': picked?.organizationId === customer.organizationId }"
                data-testid="recent-customer"
                @click="choose(customer)"
              >
                {{ customer.name }}
              </button>
            </div>

            <nav
              v-if="view !== 'types'"
              class="crumbs"
              :aria-label="t('orders.newOrder.customer.path')"
            >
              <button type="button" class="crumb" @click="view = 'types'">
                {{ t('orders.newOrder.customer.typeCrumb') }}
              </button>
              <StaffIcon name="right" :size="14" />
              <button
                v-if="view === 'members'"
                type="button"
                class="crumb"
                @click="openList(group?.type ?? 'GROUP')"
              >
                {{ t(`orders.newOrder.customer.crumbs.${group?.type ?? 'GROUP'}`) }}
              </button>
              <span v-else class="crumb crumb--here" aria-current="step">
                {{ t(`orders.newOrder.customer.crumbs.${listType}`) }}
              </span>
              <template v-if="view === 'members'">
                <StaffIcon name="right" :size="14" />
                <span class="crumb crumb--here" aria-current="step">
                  {{ t('orders.newOrder.customer.memberCrumb') }}
                </span>
              </template>
            </nav>
            <p v-else class="crumbs">
              <span class="crumb crumb--title" data-testid="new-order-type-heading">{{
                t('orders.newOrder.customer.typeCrumb')
              }}</span>
            </p>

            <div v-if="view === 'types'" class="types">
              <button
                v-for="type in ['PERSON', 'GROUP'] as const"
                :key="type"
                type="button"
                class="type"
                :data-testid="`type-${type}`"
                @click="openList(type)"
              >
                <StaffIcon :name="type === 'PERSON' ? 'user' : 'users'" :size="28" />
                <b>{{ t(`orders.newOrder.customer.types.${type}.title`) }}</b>
                <span>{{ t(`orders.newOrder.customer.types.${type}.text`) }}</span>
              </button>
            </div>

            <section v-else-if="view === 'list'" class="box">
              <div class="field">
                <StaffIcon name="search" :size="16" />
                <input
                  v-model="listSearch"
                  type="search"
                  autocomplete="off"
                  maxlength="100"
                  :aria-label="t(`orders.newOrder.customer.listSearch.${listType}`)"
                  :placeholder="t(`orders.newOrder.customer.listSearch.${listType}`)"
                />
              </div>
              <div class="labels" role="group" :aria-label="t('orders.newOrder.customer.label')">
                <span class="lbl" aria-hidden="true">{{
                  t('orders.newOrder.customer.label')
                }}</span>
                <button
                  v-for="value in labelOptions"
                  :key="value ?? 'all'"
                  type="button"
                  class="lchip"
                  :class="{ 'lchip--on': label === value }"
                  :aria-pressed="label === value"
                  @click="label = value"
                >
                  {{ labelText(value) }}
                </button>
              </div>
              <p v-if="listState === 'loading'" class="muted" role="status">
                {{ t('orders.newOrder.customer.loading') }}
              </p>
              <p v-else-if="listState === 'error'" class="muted" role="alert">
                {{ t('orders.newOrder.customer.error') }}
                <button type="button" class="link" @click="loadList">
                  {{ t('orders.newOrder.customer.retry') }}
                </button>
              </p>
              <p v-else-if="listResults.length === 0" class="muted" role="status">
                {{ t('orders.newOrder.customer.empty') }}
              </p>
              <div v-else class="opts" role="radiogroup">
                <button
                  v-for="customer in listResults"
                  :key="customer.organizationId"
                  type="button"
                  role="radio"
                  class="opt"
                  :class="{ 'opt--on': picked?.organizationId === customer.organizationId }"
                  :aria-checked="picked?.organizationId === customer.organizationId"
                  data-testid="customer-option"
                  @click="choose(customer)"
                >
                  <span class="opt__who">
                    <b>{{ customer.name }}</b>
                    <small>{{ subtitleOf(customer) }}</small>
                  </span>
                  <OrganizationTags :type="customer.type" :label="customer.label" />
                  <span class="rad" aria-hidden="true" />
                </button>
              </div>
            </section>

            <section v-else class="box">
              <span class="lbl">{{
                t('orders.newOrder.customer.whoFor', { name: group?.name ?? '' })
              }}</span>
              <p v-if="(group?.members.length ?? 0) === 0" class="muted">
                {{ t('orders.newOrder.customer.noMembers') }}
              </p>
              <div v-else class="opts" role="radiogroup">
                <button
                  v-for="member in group?.members ?? []"
                  :key="member.userId"
                  type="button"
                  role="radio"
                  class="opt"
                  :class="{ 'opt--on': pickedMember?.userId === member.userId }"
                  :aria-checked="pickedMember?.userId === member.userId"
                  data-testid="member-option"
                  @click="pickMember(member)"
                >
                  <span class="opt__who">
                    <b>{{ member.fullName }}</b>
                    <small v-if="member.phone" class="mono">{{ formatPhone(member.phone) }}</small>
                  </span>
                  <span class="rad" aria-hidden="true" />
                </button>
              </div>
            </section>
          </template>
        </div>

        <footer class="nod__foot">
          <div v-if="ready && picked" class="chosen" data-testid="chosen-customer">
            <span class="lbl">{{ t('orders.newOrder.customer.selected') }}</span>
            <b>{{ picked.name }}</b>
            <span class="chosen__line">
              {{ pickedLine }}
              <OrganizationTags :type="picked.type" :label="picked.label" />
            </span>
          </div>
          <span v-else class="hint">{{ t('orders.newOrder.customer.chooseHint') }}</span>
          <button
            type="button"
            class="next"
            :disabled="!ready"
            data-testid="new-order-customer-next"
            @click="next"
          >
            {{ t('orders.newOrder.customer.next') }}
            <StaffIcon name="arrow" :size="16" />
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* The design's step 1 dialog (760px over the list at 1440, nearly full width at 768 and 390). */
.nod {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}

:root[data-staff-app] .nod {
  padding: calc(16px + var(--safe-top, 0px)) 16px calc(16px + var(--safe-bottom, 0px));
}

.nod--closing {
  pointer-events: none;
}

.nod__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-modal);
}

.nod__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 760px;
  max-height: 100%;
  border-radius: 20px;
  background: var(--w);
  color: var(--ink);
  outline: none;
  box-shadow: var(--sh-cmdk);
}

.nod__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px 18px;
  border-bottom: 1px solid var(--ef);
}

.nod__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.nod__sub {
  margin: 4px 0 0;
  font-size: var(--fs-body);
  color: var(--t2);
}

.nod__x {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: 6px;
  border: 1px solid var(--e8);
  border-radius: 8px;
  background: var(--w);
  color: var(--ink);
  cursor: pointer;
}

.nod__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding: 20px 24px;
  overflow-y: auto;
}

.nod__note {
  margin: 0;
  padding: 16px;
  border-radius: 12px;
  background: var(--f5);
  color: var(--t2);
}

.nod__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  border-top: 1px solid var(--ef);
}

.lbl {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t3);
}

.sect {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--t3);
}

.field:focus-within {
  border-color: var(--acc);
  box-shadow: var(--ring-focus);
}

.field input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
  outline: none;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--e8);
  border-radius: 12px;
  background: var(--w);
  box-shadow: var(--sh-dropdown);
}

.res {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 128px;
  gap: 12px;
  align-items: center;
  min-height: 52px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.res:hover,
.res:focus-visible {
  background: var(--f5);
}

.res__who,
.opt__who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.res__who b,
.opt__who b {
  overflow-wrap: anywhere;
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.res__who small,
.opt__who small {
  font-size: var(--fs-small);
  color: var(--t3);
}

.res__go {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  font-size: var(--fs-body);
  color: var(--t2);
  white-space: nowrap;
}

.recent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chip,
.lchip {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 999px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.chip--on {
  border-color: var(--acc);
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.lchip--on {
  border-color: var(--btn-ink-bg);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--t3);
}

.crumb {
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 500;
  cursor: pointer;
}

/* The design's «Mijoz turi» heading above the two type cards: accent text. */
.crumb--title {
  color: var(--acc-fg);
  cursor: default;
}

.nod__alert {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--red);
  border-radius: 12px;
  background: var(--acc-bg2);
  color: var(--red);
  font-size: var(--fs-body);
  font-weight: 500;
}

.crumb--here {
  color: var(--ink);
  font-weight: 600;
  cursor: default;
}

.types {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.type {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 28px;
  border: 1px solid var(--e8);
  border-radius: 14px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.type:hover {
  border-color: var(--acc);
  background: var(--hov);
}

.type b {
  font-size: 20px;
  font-weight: 600;
}

.type span {
  font-size: var(--fs-body-lg);
  color: var(--t2);
}

.box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--e8);
  border-radius: 14px;
}

.labels {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.opts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 12px 16px;
  border: 1px solid var(--e8);
  border-radius: 10px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.opt .opt__who {
  flex: 1;
}

.opt--on {
  border-color: var(--acc);
  background: var(--acc-bg);
}

.rad {
  flex: none;
  width: 20px;
  height: 20px;
  border: 2px solid var(--b5);
  border-radius: 50%;
}

.opt--on .rad {
  border: 6px solid var(--acc);
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  margin: 0;
  padding: 8px 4px;
  font-size: var(--fs-body);
  color: var(--t3);
}

.link {
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.hint {
  font-size: 15px;
  color: var(--t2);
}

.chosen {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chosen b {
  font-size: var(--fs-section);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.chosen__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body);
  color: var(--t2);
}

.next {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 18px;
  border: 1px solid var(--acc);
  border-radius: 10px;
  background: var(--acc);
  color: var(--acc-on);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 600;
  cursor: pointer;
}

.next:hover:not(:disabled) {
  border-color: var(--acc-hover);
  background: var(--acc-hover);
}

.next:disabled {
  border-color: var(--e8);
  background: var(--ef);
  color: var(--b5);
  cursor: not-allowed;
}

button:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* Phone: the types stack, the results drop their tags, the footer stacks. */
@media (max-width: 599px) {
  .nod__head,
  .nod__body,
  .nod__foot {
    padding-right: 16px;
    padding-left: 16px;
  }

  .types {
    grid-template-columns: 1fr;
  }

  .type {
    padding: 18px;
  }

  .res {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .res__tags {
    display: none;
  }

  .nod__foot {
    flex-direction: column;
    align-items: stretch;
  }

  .next {
    justify-content: center;
  }
}

@media (pointer: coarse), (hover: none) {
  .nod__x {
    width: 44px;
    height: 44px;
    margin-top: 0;
  }

  .crumb {
    min-height: 44px;
  }
}
</style>
