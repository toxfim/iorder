<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useServices } from '@/app/services';
import { canManageOrganizations } from '@/features/staff-shell/organizations-access';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import StateView from '@core/components/ui/StateView.vue';
import { ORDER_STATUSES } from '@iorder/shared';
import { usePagedOrders } from '@/features/staff-orders/composables/use-paged-orders';
import { ordersOfRequest, totalsOf } from '@/features/staff-orders/domain/order-filters';
import {
  isClosedWithoutDelivery,
  isFullSummary,
  totalOf,
  type OrderSummary,
} from '@/features/staff-orders/domain/order-model';
import { paymentTone, stageTone } from '@/features/staff-orders/domain/order-presentation';
import { useFormat } from '@core/i18n/use-format';
import { compareMoney } from '@core/lib/money';
import { formatPhone, phoneDigits } from '@core/lib/phone';
import { hasValidTotal } from '@/features/staff-orders/domain/order-sort';
import type { MemberView } from '../domain/directory-model';
import { useDirectoryActions } from '../composables/use-directory-actions';
import ActiveBadge from './ActiveBadge.vue';
import PersonAvatar from './PersonAvatar.vue';
import OrganizationBalanceSection from '@/features/staff-organizations/components/OrganizationBalanceSection.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();
const { directoryStore, ordersApi, ordersStore, currentUser } = useServices();
// The purchasing manager reads this page; the server refuses every change anyway.
const canEdit = computed(() => canManageOrganizations(currentUser.user.value?.staffRoles ?? []));
const { formatMoney, formatMonthYear, formatShortDateTime } = useFormat();
const actions = useDirectoryActions();

const organization = computed(() =>
  directoryStore.organization(String(route.params.organizationId ?? '')),
);
const members = computed(() =>
  organization.value ? directoryStore.membersOf(organization.value.id) : [],
);
// The organization's orders page by page from the server, newest first; the count covers all.
const paged = usePagedOrders(
  ordersApi,
  () => ordersOfRequest({ organizationId: String(route.params.organizationId ?? '') }),
  { changes: ordersStore.revision },
);
const orders = paged.orders;
const orderCount = computed(() => totalsOf(paged.counts.value, ORDER_STATUSES).count);
const hasOwner = computed(() => members.value.some((m) => m.role === 'SHOP_OWNER' && m.isActive));

const busy = ref(false);
async function toggleActive(): Promise<void> {
  const value = organization.value;
  if (!value || busy.value) return;
  busy.value = true;
  try {
    await actions.setOrganizationActive(value, !value.isActive);
  } finally {
    busy.value = false;
  }
}

const memberColumns = computed<DataTableColumn<MemberView>[]>(() => [
  {
    key: 'name',
    label: t('customers.org.columns.name'),
    truncate: true,
    text: (m) => m.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: 'phone',
    label: t('customers.org.columns.phone'),
    width: '180px',
    hideOnCard: true,
    text: (m) => formatPhone(m.phone),
    compare: (a, b) => phoneDigits(a.phone).localeCompare(phoneDigits(b.phone)),
  },
  {
    key: 'telegram',
    label: t('customers.org.columns.telegram'),
    width: '190px',
    hideOnCard: true,
    text: (m) => m.telegramUsername,
  },
  { key: 'role', label: t('customers.org.columns.role'), width: '170px', hideOnCard: true },
  { key: 'status', label: t('customers.org.columns.status'), width: '130px', hideOnCard: true },
]);

// Money columns exist only when the list holds FULL summaries (the server's shape decides).
const hasMoney = computed(() => orders.value.some(isFullSummary));
const orderColumns = computed<DataTableColumn<OrderSummary>[]>(() => [
  {
    key: 'number',
    label: t('orders.columns.number'),
    width: '130px',
    text: (o) => o.orderNumber,
    compare: (a, b) => (a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0),
  },
  {
    key: 'submitted',
    label: t('orders.columns.submitted'),
    width: '160px',
    text: (o) => formatShortDateTime(o.submittedAt),
    hasSortValue: (o) => Number.isFinite(Date.parse(o.submittedAt)),
    compare: (a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt),
  },
  {
    key: 'placedBy',
    label: t('orders.columns.placedBy'),
    truncate: true,
    hidden: !hasMoney.value,
    text: (o) => (isFullSummary(o) ? o.placedBy.fullName : ''),
  },
  { key: 'stage', label: t('orders.columns.stage'), width: '170px' },
  { key: 'payment', label: t('orders.columns.payment'), width: '130px', hidden: !hasMoney.value },
  {
    key: 'total',
    label: t('orders.columns.total'),
    align: 'end',
    width: '170px',
    hidden: !hasMoney.value,
    text: (o) => {
      const total = totalOf(o);
      return total === null ? '' : `${formatMoney(total)} ${t('common.currency')}`;
    },
    hasSortValue: (o) => hasValidTotal(totalOf(o)),
    compare: (a, b) => compareMoney(totalOf(a) ?? '0', totalOf(b) ?? '0'),
  },
]);
const state = computed(() => {
  if (directoryStore.state.value === 'loading') return 'loading';
  if (directoryStore.state.value === 'error' || directoryStore.state.value === 'denied') {
    return directoryStore.state.value;
  }
  return organization.value ? 'ready' : 'empty';
});
</script>

<template>
  <div class="page">
    <AppBackLink :to="{ name: 'staff-customers' }">{{ t('customers.title') }}</AppBackLink>
    <StateView
      :state="state"
      :title="state === 'empty' ? t('customers.org.notFound') : undefined"
      :description="state === 'empty' ? '' : undefined"
      @retry="directoryStore.load()"
    >
      <template v-if="organization">
        <!-- v8 company card: mark, name with status pill, contact lines, then the figure strip. -->
        <section class="card summary">
          <header class="head">
            <span class="head__mark" aria-hidden="true">
              <StaffIcon name="building" :size="24" />
            </span>
            <div class="head__main">
              <div class="head__title-row">
                <h1 class="head__title">{{ organization.name }}</h1>
                <ActiveBadge :active="organization.isActive" />
              </div>
              <span class="head__line"
                >{{ organization.address }} · {{ formatPhone(organization.phone) }}</span
              >
              <span class="head__meta">
                {{ t('customers.org.telegramLine') }}{{ ' '
                }}<span class="mono head__tg">{{ organization.telegramGroup }}</span> ·
                {{ t('customers.org.since', { date: formatMonthYear(organization.since) }) }}
              </span>
            </div>
            <AppButton
              v-if="canEdit"
              :variant="organization.isActive ? 'secondary' : 'primary'"
              size="sm"
              :disabled="busy"
              :aria-busy="busy || undefined"
              @click="toggleActive"
            >
              {{ organization.isActive ? t('customers.org.block') : t('customers.org.activate') }}
            </AppButton>
          </header>

          <dl class="tiles">
            <div class="tile">
              <dt>{{ t('customers.org.members') }}</dt>
              <dd>{{ members.length }}</dd>
            </div>
            <div class="tile">
              <dt>{{ t('customers.org.orders') }}</dt>
              <dd>{{ orderCount }}</dd>
            </div>
          </dl>
        </section>

        <p v-if="!hasOwner" class="notice" role="status">
          <StaffIcon name="alert" :size="16" class="notice__icon" />
          {{ t('customers.org.noOwner') }}
        </p>

        <section class="block" data-testid="org-members" aria-labelledby="org-members-title">
          <header class="block__head">
            <h2 id="org-members-title" class="block__title">{{ t('customers.org.members') }}</h2>
            <span class="block__sub">{{
              t('customers.membersCount', { count: members.length }, members.length)
            }}</span>
            <!-- Mijozlar filtered by this organization (its people among all customers). -->
            <RouterLink
              v-if="organization && members.length > 0"
              class="block__link"
              :to="{ name: 'staff-customers', query: { org: organization.id } }"
              data-testid="org-people-link"
              >{{ t('customers.people.showPeople') }}</RouterLink
            >
          </header>
          <DataTable
            :columns="memberColumns"
            :rows="members"
            :row-key="(m: MemberView) => m.id"
            :row-to="
              (m: MemberView) => ({
                name: 'staff-member',
                params: { organizationId: m.organizationId, memberId: m.id },
              })
            "
            :label="t('customers.org.members')"
            :empty-text="t('customers.org.noMembers')"
            :density-toggle="false"
          >
            <template #cell-name="{ row }">
              <span class="who">
                <PersonAvatar :name="row.name" />
                <span class="row__name"><PersonName :name="row.name" :user-id="row.id" /></span>
              </span>
            </template>
            <template #cell-role="{ row }">
              <AppBadge :tone="row.role === 'SHOP_OWNER' ? 'accent' : 'neutral'">
                {{ t(`roles.organization.${row.role}`) }}
              </AppBadge>
            </template>
            <template #cell-status="{ row }">
              <ActiveBadge :active="row.isActive" />
            </template>
            <template #card="{ row }">
              <span class="who">
                <PersonAvatar :name="row.name" />
                <span class="row__main">
                  <span class="row__name"><PersonName :name="row.name" :user-id="row.id" /></span>
                  <span class="row__meta"
                    >{{ formatPhone(row.phone) }} · {{ row.telegramUsername }}</span
                  >
                </span>
              </span>
              <span class="badges">
                <AppBadge :tone="row.role === 'SHOP_OWNER' ? 'accent' : 'neutral'">
                  {{ t(`roles.organization.${row.role}`) }}
                </AppBadge>
                <ActiveBadge :active="row.isActive" />
              </span>
            </template>
          </DataTable>
        </section>

        <section class="block" data-testid="org-orders" aria-labelledby="org-orders-title">
          <header class="block__head">
            <h2 id="org-orders-title" class="block__title">{{ t('customers.org.orders') }}</h2>
            <span class="block__sub">{{
              t('customers.ordersCount', { count: orderCount }, orderCount)
            }}</span>
          </header>
          <DataTable
            :columns="orderColumns"
            :rows="orders"
            :row-key="(o: OrderSummary) => o.id"
            :row-to="(o: OrderSummary) => ({ name: 'staff-order', params: { orderId: o.id } })"
            :label="t('customers.org.orders')"
            :empty-text="t('customers.org.noOrders')"
            :density-toggle="false"
          >
            <template #cell-number="{ row }">
              <span class="mono row__id">{{ row.orderNumber }}</span>
            </template>
            <template #cell-stage="{ row }">
              <AppBadge :tone="stageTone(row.status)" dot>{{
                t(`orders.stages.${row.status}`)
              }}</AppBadge>
            </template>
            <template #cell-placedBy="{ row }">
              <PersonName
                v-if="isFullSummary(row)"
                :name="row.placedBy.fullName"
                :user-id="row.placedBy.userId"
              />
            </template>
            <template #cell-payment="{ row }">
              <AppBadge
                v-if="isFullSummary(row) && !isClosedWithoutDelivery(row.status)"
                :tone="paymentTone(row.paymentStatus)"
              >
                {{ t(`orders.payment.${row.paymentStatus}`) }}
              </AppBadge>
            </template>
            <template #card="{ row }">
              <span class="card__top">
                <span class="mono row__id">{{ row.orderNumber }}</span>
                <AppBadge :tone="stageTone(row.status)" dot>{{
                  t(`orders.stages.${row.status}`)
                }}</AppBadge>
              </span>
              <span class="row__meta">
                <span>
                  {{ formatShortDateTime(row.submittedAt) }}
                  <template v-if="isFullSummary(row)">
                    ·
                    <PersonName :name="row.placedBy.fullName" :user-id="row.placedBy.userId" />
                  </template>
                </span>
              </span>
              <span v-if="isFullSummary(row)" class="badges">
                <b class="num">{{ formatMoney(row.totalAmount) }} {{ t('common.currency') }}</b>
                <AppBadge
                  v-if="!isClosedWithoutDelivery(row.status)"
                  :tone="paymentTone(row.paymentStatus)"
                >
                  {{ t(`orders.payment.${row.paymentStatus}`) }}
                </AppBadge>
              </span>
            </template>
          </DataTable>
          <AppButton
            v-if="paged.nextCursor.value !== null"
            variant="secondary"
            class="more-orders"
            :loading="paged.loadingMore.value"
            @click="paged.loadMore()"
          >
            {{ t('orders.page.loadMore') }}
          </AppButton>
        </section>

        <!-- The debt comes from the server's balance (received orders minus payments). -->
        <OrganizationBalanceSection :organization-id="organization.id" />
      </template>
    </StateView>
  </div>
</template>

<style scoped>
/* The next page of this list's orders (the server pages them). */
.more-orders {
  display: flex;
  margin: 12px auto 0;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: viewIn 0.35s var(--ease) both;
}

.card {
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.head__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 10px;
  background: var(--acc-bg);
  color: var(--acc);
}

.head__main {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.head__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.head__title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.head__line {
  font-size: var(--fs-small);
}

.head__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.head__tg {
  color: var(--ink);
}

/* v8 figure strip: one hairline box split into cells (label 11px grey, value 13px/500). */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  margin: 0;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
}

.tile + .tile {
  box-shadow: inset 1px 0 0 var(--e8);
}

.tile dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.tile dd {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--r-card);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-small);
}

.notice__icon {
  margin-top: 1px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.block__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.block__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.block__sub {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.block__link {
  margin-left: auto;
  color: var(--acc-fg);
  font-size: var(--fs-small);
  font-weight: 600;
  text-decoration: none;
}

.block__link:hover {
  text-decoration: underline;
}

.block__link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
  border-radius: var(--r-btn-sm);
}

.who {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.row__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row__name {
  font-size: var(--fs-small);
}

.row__id {
  font-size: var(--fs-small);
  font-weight: 500;
}

.row__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.badges,
.card__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.card__top {
  justify-content: space-between;
}
</style>
