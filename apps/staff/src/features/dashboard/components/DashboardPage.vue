<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { FAKE_API_ENABLED } from '@core/app/env';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { StaffIconName } from '@/components/ui/staff-icons';
import DashboardSummaryPanel from '@/features/staff-orders/components/DashboardSummaryPanel.vue';
import { ageMessage } from '@/features/staff-orders/domain/dashboard-summary-presentation';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import ApproveOrderDialog from '@/features/staff-orders/components/ApproveOrderDialog.vue';
import { useAllocationPlan } from '@/features/staff-orders/composables/use-allocation-plan';
import type { PlanChoice } from '@/features/staff-orders/domain/allocation-plan';
import OrdersTruncatedNote from '@/features/staff-orders/components/OrdersTruncatedNote.vue';
import { useOrderActions } from '@/features/staff-orders/composables/use-order-actions';
import type {
  FullOrderSummary,
  FullOrderDetail,
  PaymentMethod,
} from '@/features/staff-orders/domain/order-model';
import { useFormat } from '@core/i18n/use-format';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import { canViewPriceAdmin } from '@/features/staff-shell/price-access';
import { useCountUp } from '../composables/use-count-up';
import { dateLineParts, firstName, greetingPeriod } from '../domain/greeting';
import ActivityFeed from './ActivityFeed.vue';
import DashCard from './DashCard.vue';
import SalesCard from './SalesCard.vue';
import StageDistribution from './StageDistribution.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const router = useRouter();
const {
  ordersStore,
  orderDebtStore,
  dashboardSummaryStore,
  awaitingApproval,
  currentUser,
  priceVersionStore,
  unpricedCountStore,
  clock,
} = useServices();
// Already a KPI card above the summary (design v8 keeps "Tasdiq kutmoqda" in both places).
const SUMMARY_SHOWN_ABOVE = ['today'];
// Design v8 turns a waiting time orange after two hours. A visual cue only, not a business rule.
const LONG_WAIT_MINUTES = 120;
const { formatMoney, formatMoneyWithCurrency, formatDate, formatTime, formatShortDateTime } =
  useFormat();
const { formatUsd } = useCostFormat();
const actions = useOrderActions();

const user = computed(() => currentUser.user.value);

// --- header -------------------------------------------------------------------------------------

const roleLabel = computed(() =>
  (user.value?.staffRoles ?? []).map((role) => t(`roles.staff.${role}`)).join(', '),
);
const dateLine = computed(() => {
  const parts = dateLineParts(clock.now());
  return t('dashboard.dateLine', {
    date: t('dates.dayMonth', {
      weekday: t(`dates.weekdays.${parts.weekday}`),
      day: parts.day,
      month: t(`dates.months.${parts.month}`),
    }),
    role: roleLabel.value,
  });
});
const greeting = computed(() =>
  t(`dashboard.greeting.${greetingPeriod(clock.now())}`, {
    name: firstName(user.value?.displayName ?? ''),
  }),
);
const version = priceVersionStore.version;
const versionLine = computed(() =>
  version.value
    ? t('dashboard.priceList.version', {
        number: version.value.number,
        date: `${formatDate(version.value.publishedAt)}, ${formatTime(version.value.publishedAt)}`,
      })
    : '',
);
// Products still waiting for a price: shown to the people who set prices only.
const unpricedCount = computed(() =>
  canViewPriceAdmin(user.value?.staffRoles ?? []) ? (unpricedCountStore.count.value ?? 0) : 0,
);

// --- numbers -------------------------------------------------------------------------------------
// Every figure comes from the server: the dashboard summary, the debt counts and the manager's
// queue (read whole; ordersStore.truncated says when it was cut). No page holds the history.

const pending = ordersStore.pending;
// "Today" comes from the server's summary, the debt from the server's order counts.
const summary = dashboardSummaryStore.summary;
// The same figure the sidebar badge and the quick filter show (see awaiting-approval.ts).
const pendingCount = useCountUp(computed(() => awaitingApproval.count.value ?? 0));
const todayCount = useCountUp(computed(() => summary.value?.today?.count ?? 0));
const NO_FIGURE = '–';
// Known from the list or, while the list is not read, from the summary: a failed summary call must not hide a loaded list.
const pendingKnown = computed(() => awaitingApproval.count.value !== null);
const todayKnown = computed(() => summary.value?.today !== undefined);
const todaySum = computed(() => summary.value?.today?.totalAmount ?? null);
const ageText = (minutes: number): string => {
  const { key, params } = ageMessage(minutes);
  return t(`orders.summary.age.${key}`, params);
};
const pendingOldestAge = computed(() => {
  const minutes = awaitingApproval.oldestAgeMinutes.value;
  if (minutes === null || minutes === undefined) return null;
  return ageText(minutes);
});
const debtCount = computed(() => orderDebtStore.count.value ?? 0);
const debtCustomers = computed(() => orderDebtStore.customers.value ?? 0);
const debtTotal = computed(() =>
  orderDebtStore.sumUsd.value === null ? NO_FIGURE : formatUsd(orderDebtStore.sumUsd.value),
);
// At the current rate, from the server; left out while no rate is known. Gross unpaid orders, not the
// organizations' balance: a partial payment or an overpayment does not move it.
const debtUzs = computed(() =>
  orderDebtStore.sumUzs.value === null
    ? null
    : t('customers.approxUzs', { amount: formatMoneyWithCurrency(orderDebtStore.sumUzs.value) }),
);

interface Kpi {
  readonly id: string;
  readonly label: string;
  readonly icon: StaffIconName;
  readonly value: string;
  readonly sub: string;
  readonly cta: string;
  readonly query: Record<string, string>;
  /** The manager's own queue: the dark card of the design. */
  readonly dark: boolean;
}

const pendingKpi = computed((): Kpi => ({
  id: 'pending',
  label: t('dashboard.kpi.pending'),
  icon: 'clock',
  value: pendingKnown.value ? String(pendingCount.value) : NO_FIGURE,
  sub: !pendingKnown.value
    ? ''
    : pendingOldestAge.value
      ? t('orders.summary.oldest', { age: pendingOldestAge.value })
      : t('dashboard.kpi.queueEmpty'),
  cta: t('dashboard.kpi.openQueue'),
  query: { stage: 'SUBMITTED' },
  dark: true,
}));
const todayKpi = computed((): Kpi => ({
  id: 'today',
  label: t('dashboard.kpi.today'),
  icon: 'bag',
  value: todayKnown.value ? String(todayCount.value) : NO_FIGURE,
  sub:
    todaySum.value === null
      ? ''
      : t('dashboard.kpi.todaySub', { sum: formatMoney(todaySum.value) }),
  cta: t('dashboard.kpi.view'),
  query: { period: 'today' },
  dark: false,
}));
const debtKpi = computed((): Kpi => ({
  id: 'debt',
  label: t('dashboard.kpi.debt'),
  icon: 'wallet',
  value: debtTotal.value,
  sub: [
    ...(debtUzs.value === null ? [] : [debtUzs.value]),
    t('dashboard.kpi.debtOrders', { count: debtCount.value }, debtCount.value),
    t('dashboard.kpi.debtCustomers', { count: debtCustomers.value }, debtCustomers.value),
  ].join(' · '),
  cta: t('dashboard.kpi.view'),
  query: { period: 'debt' },
  dark: false,
}));
const kpis = computed((): Kpi[] => [pendingKpi.value, todayKpi.value, debtKpi.value]);

// The v8 lists: every order waiting for the manager, and the first four debts.
const queue = computed(() => pending.value);
const debts = orderDebtStore.newest;

// The server count is not capped, the listed rows are: say so instead of letting them disagree.
const queuePartial = computed(
  () =>
    ordersStore.state.value === 'ready' && queue.value.length < (awaitingApproval.count.value ?? 0),
);
const queueCount = computed(() => awaitingApproval.count.value ?? queue.value.length);

const waitedMinutes = (order: FullOrderSummary): number =>
  Math.max(0, Math.floor((clock.now().getTime() - Date.parse(order.submittedAt)) / 60_000));

const permissions = computed(() => actions.permissions());

// "Ochish" opens the full order page.
const open = (order: FullOrderSummary): void =>
  void router.push({ name: 'staff-order', params: { orderId: order.id } });
const goOrders = (query: Record<string, string>): void =>
  void router.push({ name: 'staff-orders', query });

// --- approval: a small confirmation first (it can skip accounting and shows what is approved) -----

const approveOpen = ref(false);
// Kept after the dialog closes so its text does not blank out during the exit animation.
const approving = ref<FullOrderSummary | null>(null);
const approveBusy = ref(false);

const approvalPlan = useAllocationPlan();
let stockRefused = false;

function askApprove(order: FullOrderSummary): void {
  approving.value = order;
  approveOpen.value = true;
}

async function confirmApprove(
  skipAccounting: boolean,
  paymentMethod: PaymentMethod,
  order: FullOrderDetail,
  plan: PlanChoice,
): Promise<void> {
  if (approveBusy.value) return;
  approveBusy.value = true;
  try {
    // The dialog read the order just now: its row version is the one the manager decided on.
    await actions.approve(order, paymentMethod, plan, skipAccounting);
    // A conflict already toasted and re-read the list; either way the order is no longer pending.
    // Only a refusal over stock keeps the dialog open: the fresh plan is one click from approved.
    if (!stockRefused) approveOpen.value = false;
  } finally {
    approveBusy.value = false;
    stockRefused = false;
  }
}

const stagger = (index: number, base = 0): string => `${base + Math.min(index, 12) * 40}ms`;

// Loading, error and denied come from the orders store; an empty store still shows the page
// with zeros and the empty-list texts.
const pageState = computed(() =>
  ordersStore.state.value === 'empty' ? 'ready' : ordersStore.state.value,
);
</script>

<template>
  <StateView :state="pageState" @retry="ordersStore.load()">
    <div class="home">
      <header class="head">
        <div class="head__text">
          <h1 class="head__title">{{ greeting }}</h1>
          <span class="head__date">{{ dateLine }}</span>
        </div>
        <RouterLink
          v-if="version"
          class="pill"
          :to="{ name: 'staff-prices' }"
          :title="t('dashboard.priceList.open')"
        >
          <StaffIcon name="tags" :size="15" class="pill__icon" />
          <span>{{ versionLine }}</span>
          <span v-if="unpricedCount > 0" class="pill__chip" data-testid="dashboard-unpriced">{{
            t('dashboard.priceList.unpriced', { count: unpricedCount }, unpricedCount)
          }}</span>
        </RouterLink>
      </header>

      <OrdersTruncatedNote />

      <div class="kpis">
        <button
          v-for="kpi in kpis"
          :key="kpi.id"
          type="button"
          class="kpi"
          :class="kpi.dark ? 'kpi--sand' : 'kpi--link'"
          @click="goOrders(kpi.query)"
        >
          <span class="kpi__top">
            <span class="kpi__label">{{ kpi.label }}</span>
            <StaffIcon :name="kpi.icon" :size="18" class="kpi__icon" />
          </span>
          <span class="kpi__big num" :data-testid="kpi.id === 'debt' ? 'debt-sum' : undefined">
            {{ kpi.value }}
          </span>
          <span class="kpi__foot">
            <span class="kpi__sub">{{ kpi.sub }}</span>
            <span class="kpi__cta">{{ kpi.cta }}</span>
          </span>
        </button>
      </div>

      <DashboardSummaryPanel variant="card" :exclude="SUMMARY_SHOWN_ABOVE" />

      <div class="columns">
        <DashCard
          :title="t('dashboard.queue.title')"
          :subtitle="t('dashboard.queue.subtitle', { count: queueCount }, queueCount)"
          :action-label="t('dashboard.queue.openQueue')"
          @action="goOrders({ stage: 'SUBMITTED' })"
        >
          <article
            v-for="(order, index) in queue"
            :key="order.id"
            class="row"
            :style="{ animationDelay: stagger(index) }"
          >
            <button type="button" class="row__main" @click="open(order)">
              <span class="row__line">
                <span class="row__org">{{ order.organizationName }}</span>
                <span class="row__id">{{ order.orderNumber }}</span>
                <span class="row__when">{{ formatShortDateTime(order.submittedAt) }}</span>
              </span>
              <span class="row__meta">
                <PersonName :name="order.placedBy.fullName" :user-id="order.placedBy.userId" /> ·
                {{ t('dashboard.queue.positions', { count: order.itemCount }, order.itemCount) }}
              </span>
            </button>
            <div class="row__sum">
              <b class="num">{{ formatMoney(order.totalAmount) }}</b>
              <span
                class="row__age"
                :class="{ 'row__age--long': waitedMinutes(order) > LONG_WAIT_MINUTES }"
              >
                {{ t('dashboard.queue.waiting', { age: ageText(waitedMinutes(order)) }) }}
              </span>
            </div>
            <div class="row__buttons">
              <AppButton
                variant="secondary"
                size="xs"
                :aria-label="t('dashboard.queue.openLabel', { id: order.orderNumber })"
                @click="open(order)"
              >
                {{ t('dashboard.queue.open') }}
              </AppButton>
              <!-- The design shows approve to admin too; the docs give it to the manager only. -->
              <AppButton
                v-if="permissions.canDecide"
                size="xs"
                :aria-label="t('dashboard.queue.approveLabel', { id: order.orderNumber })"
                @click="askApprove(order)"
              >
                {{ t('dashboard.queue.approve') }}
              </AppButton>
            </div>
          </article>
          <p v-if="queue.length === 0" class="empty" role="status">
            {{ t('dashboard.queue.empty') }}
          </p>
          <p v-if="queuePartial" class="empty" role="status" data-testid="queue-partial">
            {{
              t('dashboard.queue.partial', {
                shown: queue.length,
                total: awaitingApproval.count.value,
              })
            }}
          </p>
        </DashCard>

        <div class="column">
          <StageDistribution />

          <!-- No "mark paid" action here, unlike the design: PAID is derived from the
               organization's payments by the server, never set on an order by hand. -->
          <DashCard
            :title="t('dashboard.debts.title')"
            :subtitle="
              t('dashboard.debts.subtitle', { sum: debtTotal, count: debtCount }, debtCount)
            "
            :action-label="t('dashboard.debts.all')"
            @action="goOrders({ period: 'debt' })"
          >
            <article
              v-for="(order, index) in debts"
              :key="order.id"
              class="row row--debt"
              :style="{ animationDelay: stagger(index, 120) }"
            >
              <button type="button" class="row__main row__main--debt" @click="open(order)">
                <span class="row__pair">
                  <span class="row__org row__org--small">{{ order.organizationName }}</span>
                  <b class="row__debt num">{{ formatUsd(order.totalUsd) }}</b>
                </span>
                <span class="row__meta">
                  {{ order.orderNumber }} · {{ formatMoneyWithCurrency(order.totalAmount) }} ·
                  {{ t(`orders.stages.${order.status}`) }}
                </span>
              </button>
            </article>
            <p v-if="debts.length === 0" class="empty" role="status">
              {{ t('dashboard.debts.empty') }}
            </p>
          </DashCard>
        </div>
      </div>

      <!-- Not in the v8 home design, kept below it: the recent actions, and sample sales figures
           (the api has no sales report yet, so a real build shows no chart). -->
      <div class="extras">
        <SalesCard v-if="FAKE_API_ENABLED" />
        <ActivityFeed />
      </div>
    </div>
    <ApproveOrderDialog
      v-model="approveOpen"
      :order="approving"
      :busy="approveBusy"
      :plan="approvalPlan"
      @confirm="confirmApprove"
    />
  </StateView>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  animation: viewIn 0.3s var(--ease) both;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.head__text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__date {
  font-size: var(--fs-small);
  color: var(--t2);
}

.pill {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-height: 38px;
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--ink);
  text-decoration: none;
}

.pill:hover {
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.pill:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.pill__icon {
  color: var(--acc);
}

.pill__chip {
  padding: 2px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: 10px;
  font-weight: 600;
}

/* Design v8: three cards, the first (the manager's own queue) dark, each one link. */
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 16px;
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 150px;
  padding: 20px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.kpi:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.kpi--link:hover {
  box-shadow: inset 0 0 0 1px var(--acc);
}

.kpi--sand {
  --t2: var(--hero-muted);
  background: var(--hero-bg);
  box-shadow: inset 0 0 0 1px var(--hero-bg);
  color: var(--hero-fg);
}

.kpi--sand:hover {
  box-shadow: inset 0 0 0 1px var(--acc);
}

.kpi__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kpi__label {
  font-size: var(--fs-small);
  color: var(--t2);
}

.kpi__icon {
  flex: none;
  color: var(--t2);
}

.kpi--sand .kpi__icon {
  color: var(--acc);
}

.kpi__big {
  font-size: 30px;
  font-weight: 400;
  line-height: 1.1;
  overflow-wrap: anywhere;
}

.kpi__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-top: auto;
}

.kpi__sub {
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.kpi__cta {
  flex: none;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--acc-fg);
  white-space: nowrap;
}

.kpi--sand .kpi__cta {
  color: var(--acc-on-dark);
}

.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 20px;
  align-items: start;
}

.column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.extras {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: 20px;
  align-items: start;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
  animation: rowIn 0.3s ease both;
}

.row--debt {
  padding: 12px 20px;
}

.row__main {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row__main--debt {
  flex-basis: 100%;
  gap: 6px;
}

.row__main:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-kbd);
}

.row__line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
}

.row__pair {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.row__org {
  font-size: var(--fs-body);
  font-weight: 600;
}

.row__org--small {
  font-size: var(--fs-small);
  font-weight: 500;
}

.row__id {
  font-size: var(--fs-meta);
  color: var(--acc-fg);
}

.row__when,
.row__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.row--debt .row__meta {
  font-size: 10px;
}

.row__debt {
  font-size: var(--fs-small);
  font-weight: 400;
  white-space: nowrap;
}

.row__sum {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.row__sum b {
  font-size: var(--fs-body);
  font-weight: 400;
}

.row__age {
  font-size: 10px;
  color: var(--t2);
}

.row__age--long {
  color: var(--acc-fg);
}

.row__buttons {
  display: flex;
  gap: 8px;
}

.empty {
  margin: 0;
  padding: 32px 20px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}

@media (max-width: 1100px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .kpis {
    grid-template-columns: 1fr;
  }

  .head__title {
    font-size: 24px;
  }

  .row {
    padding: 14px 16px;
  }

  .row__sum {
    align-items: flex-start;
  }
}

@media (pointer: coarse), (hover: none) {
  .row__main {
    min-height: 44px;
  }
}
</style>
