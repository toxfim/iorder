<script setup lang="ts">
import type { OrganizationRole } from '@iorder/shared';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { useServices } from '@/app/services';
import { canManageOrganizations } from '@/features/staff-shell/organizations-access';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import StateView from '@core/components/ui/StateView.vue';
import { ORDER_STATUSES } from '@iorder/shared';
import { usePagedOrders } from '@/features/staff-orders/composables/use-paged-orders';
import { ordersOfRequest, totalsOf } from '@/features/staff-orders/domain/order-filters';
import { isFullSummary } from '@/features/staff-orders/domain/order-model';
import { stageTone } from '@/features/staff-orders/domain/order-presentation';
import BlockUserDialog from '@/features/staff-users/components/BlockUserDialog.vue';
import RemovalStatusPanel from '@/features/staff-users/components/RemovalStatusPanel.vue';
import { useFormat } from '@core/i18n/use-format';
import { formatPhone, telHref } from '@core/lib/phone';
import { useDirectoryActions } from '../composables/use-directory-actions';
import { customersListLocation, forgetCustomersList } from '../composables/customers-list-memory';
import ActiveBadge from './ActiveBadge.vue';
import PersonAvatar from './PersonAvatar.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();
const { directoryStore, ordersApi, ordersStore, currentUser } = useServices();
// The purchasing manager reads this page; the server refuses every change anyway.
const canEdit = computed(() => canManageOrganizations(currentUser.user.value?.staffRoles ?? []));
const { formatMoney, formatDate, formatShortDateTime } = useFormat();
const actions = useDirectoryActions();

const member = computed(() => directoryStore.member(String(route.params.memberId ?? '')));
const organization = computed(() =>
  member.value ? directoryStore.organization(member.value.organizationId) : undefined,
);
// The orders this person placed, page by page from the server, newest first.
const paged = usePagedOrders(
  ordersApi,
  () => ordersOfRequest({ placedByUserId: String(route.params.memberId ?? '') }),
  { changes: ordersStore.revision },
);
const orders = paged.orders;
const orderCount = computed(() => totalsOf(paged.counts.value, ORDER_STATUSES).count);

const roleOptions = computed(() =>
  (['SHOP_OWNER', 'SELLER'] as const).map((role) => ({
    value: role,
    label: t(`roles.organization.${role}`),
  })),
);

const busy = ref(false);
async function guarded(work: () => Promise<boolean>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await work();
  } finally {
    busy.value = false;
  }
}

const changeRole = (role: OrganizationRole): void => {
  const value = member.value;
  if (value && value.role !== role) void guarded(() => actions.setMemberRole(value, role));
};
// Blocking asks first whether to also remove the person from the Telegram group (a dialog);
// unblocking is a plain action.
const blockOpen = ref(false);
const toggleActive = (): void => {
  const value = member.value;
  if (!value) return;
  if (value.isActive) blockOpen.value = true;
  else void guarded(() => actions.setMemberActive(value, true));
};
// The dialog already blocked the person on the server; this only brings the list model along.
async function onBlocked(): Promise<void> {
  const value = member.value;
  if (!value) return;
  try {
    await directoryStore.setMemberActive(value.id, false);
  } catch {
    void directoryStore.load();
  }
}

const stagger = (index: number): string => `${index * 30}ms`;
const state = computed(() => {
  if (directoryStore.state.value === 'loading') return 'loading';
  if (directoryStore.state.value === 'error' || directoryStore.state.value === 'denied') {
    return directoryStore.state.value;
  }
  return member.value ? 'ready' : 'empty';
});
// Opened from Mijozlar: back to that list with its filters. Otherwise back to the organization
// card, except for a PERSON customer, whose organization is the person themselves: then the list.
const fromList = customersListLocation();
onBeforeRouteLeave((to) => {
  if (to.name !== 'staff-customers') forgetCustomersList();
});
const backToOrganization = computed(
  () =>
    fromList === null && organization.value !== undefined && organization.value.type !== 'PERSON',
);
const backTarget = computed(() =>
  backToOrganization.value && organization.value
    ? { name: 'staff-customer', params: { organizationId: organization.value.id } }
    : (fromList ?? { name: 'staff-customers' }),
);
const backLabel = computed(() =>
  backToOrganization.value && organization.value ? organization.value.name : t('customers.title'),
);
</script>

<template>
  <div class="page">
    <AppBackLink :to="backTarget">{{ backLabel }}</AppBackLink>
    <StateView
      :state="state"
      :title="state === 'empty' ? t('customers.member.notFound') : undefined"
      :description="state === 'empty' ? '' : undefined"
      @retry="directoryStore.load()"
    >
      <div v-if="member" class="layout">
        <section class="card">
          <div class="who">
            <PersonAvatar :name="member.name" size="lg" />
            <div class="who__text">
              <h1 class="who__name"><PersonName :name="member.name" :user-id="member.id" /></h1>
              <span class="who__org">{{ organization?.name }}</span>
            </div>
          </div>

          <dl class="tiles">
            <div class="tile">
              <dt>{{ t('customers.member.phone') }}</dt>
              <dd>
                <a :href="telHref(member.phone)">{{ formatPhone(member.phone) }}</a>
              </dd>
            </div>
            <div class="tile">
              <dt>{{ t('customers.member.telegram') }}</dt>
              <dd class="mono">{{ member.telegramUsername }}</dd>
            </div>
            <div class="tile">
              <dt>{{ t('customers.member.joined') }}</dt>
              <dd>{{ formatDate(member.joinedAt) }}</dd>
            </div>
            <div class="tile">
              <dt>{{ t('customers.member.orders') }}</dt>
              <dd>{{ orderCount }}</dd>
            </div>
          </dl>

          <div class="role">
            <h2 class="role__title">{{ t('customers.member.role') }}</h2>
            <AppSegmented
              :model-value="member.role"
              :options="roleOptions"
              :label="t('customers.member.role')"
              track="e8"
              @update:model-value="changeRole"
            />
            <span class="role__hint">{{ t('customers.member.roleHint') }}</span>
          </div>

          <div class="status">
            <div class="status__text">
              <span class="status__title">{{ t('customers.member.status') }}</span>
              <ActiveBadge :active="member.isActive" />
            </div>
            <AppButton
              v-if="canEdit"
              :variant="member.isActive ? 'secondary' : 'primary'"
              size="sm"
              :disabled="busy"
              :aria-busy="busy || undefined"
              @click="toggleActive"
            >
              {{ member.isActive ? t('customers.member.block') : t('customers.member.activate') }}
            </AppButton>
          </div>

          <RemovalStatusPanel
            v-if="!member.isActive && !blockOpen"
            :key="member.id"
            :user-id="member.id"
            :blocked="!member.isActive"
            hide-when-empty
          />
        </section>

        <section class="card card--list">
          <h2 class="placed">{{ t('customers.member.placed') }}</h2>
          <ul class="list">
            <li v-for="(order, index) in orders" :key="order.id">
              <RouterLink
                :to="{ name: 'staff-order', params: { orderId: order.id } }"
                class="row"
                :style="{ animationDelay: stagger(index) }"
              >
                <span class="row__main">
                  <span class="mono row__id">{{ order.orderNumber }}</span>
                  <span class="row__meta">{{ formatShortDateTime(order.submittedAt) }}</span>
                </span>
                <AppBadge :tone="stageTone(order.status)" dot>
                  {{ t(`orders.stages.${order.status}`) }}
                </AppBadge>
                <b v-if="isFullSummary(order)" class="num">{{ formatMoney(order.totalAmount) }}</b>
              </RouterLink>
            </li>
            <li v-if="orders.length === 0" class="empty" role="status">
              {{ t('customers.member.noOrders') }}
            </li>
          </ul>
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
      </div>
    </StateView>
    <BlockUserDialog
      v-if="member"
      v-model="blockOpen"
      :user-id="member.id"
      :name="member.name"
      :groups="organization ? [organization.name] : []"
      @blocked="onBlocked"
    />
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

.layout {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 20px;
}

/* v8 white hairline cards. */
.card {
  display: flex;
  flex: 1 1 380px;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.card--list {
  flex-basis: 360px;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

.who {
  display: flex;
  align-items: center;
  gap: 16px;
}

.who__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.who__name {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.who__org {
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* v8 figure strip: one hairline box, cells divided by hairlines. */
.tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  min-width: 0;
}

.tile:nth-child(even) {
  box-shadow: inset 1px 0 0 var(--e8);
}

.tile:nth-child(n + 3) {
  border-top: 1px solid var(--e8);
}

.tile dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.tile dd {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.role {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.role__title {
  margin: 0;
  font-size: var(--fs-meta);
  font-weight: 500;
}

.role__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--e8);
}

.status__text {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status__title {
  font-size: var(--fs-small);
  font-weight: 500;
}

.placed {
  margin: 0;
  padding: 20px;
  font-size: var(--fs-section);
  font-weight: 600;
  border-bottom: 1px solid var(--e8);
}

.list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  min-height: 48px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--e8);
  color: inherit;
  font-size: var(--fs-small);
  animation: rowIn 0.3s ease both;
  transition: background-color 0.15s ease;
}

.list li:last-child .row {
  border-bottom: 0;
}

.row:hover {
  background: var(--hov);
}

.row__main {
  display: flex;
  flex: 1 1 140px;
  flex-direction: column;
  gap: 2px;
}

.row__id {
  font-size: var(--fs-small);
  font-weight: 500;
}

.row__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.empty {
  padding: 40px 20px;
  text-align: center;
  font-size: var(--fs-small);
  color: var(--t2);
}
</style>
