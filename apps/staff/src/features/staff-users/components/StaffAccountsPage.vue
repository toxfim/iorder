<script setup lang="ts">
import { STAFF_ROLES, type StaffRole } from '@iorder/shared';
import type { StaffAccountResponse, StaffDirectoryEntry } from '@iorder/shared/staff-auth';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterField from '@/components/ui/FilterField.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { StaffIconName } from '@/components/ui/staff-icons';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import PersonAvatar from '@/features/directory/components/PersonAvatar.vue';
import StaffRoleBadges from '@/features/directory/components/StaffRoleBadges.vue';
import { useFormat } from '@core/i18n/use-format';
import { canManageAccounts, maySetAccountStatus, mayChangeAccount } from '../domain/account-rules';
import { errorTextFor } from '../domain/error-text';
import AccountRowMenu, { type RowMenuItem } from './AccountRowMenu.vue';
import CreateStaffAccountDialog from './CreateStaffAccountDialog.vue';
import StaffCredentialsDialog from './StaffCredentialsDialog.vue';
import StaffTelegramDialog from './StaffTelegramDialog.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const { staffAccountsApi, staffUsersApi, currentUser } = useServices();
const { formatDateTime } = useFormat();

const viewerRoles = computed<readonly StaffRole[]>(() => currentUser.user.value?.staffRoles ?? []);
const mayBlock = computed(() => maySetAccountStatus(viewerRoles.value));

const CREDENTIAL_COLUMNS: readonly string[] = ['telegram', 'password', 'lastSignIn', 'actions'];

/** Same row shape for the table; the columns and fields that read these are hidden for a reader. */
function directoryRow(person: StaffDirectoryEntry): StaffAccountResponse {
  return { ...person, login: null, hasPassword: false, telegramLinked: false, lastSignInAt: null };
}

// A reader (the purchasing manager) gets the list without any credential fact and no action.
const readOnly = computed(() => !canManageAccounts(viewerRoles.value));
const view = useAsyncView<readonly StaffAccountResponse[]>(() =>
  readOnly.value
    ? staffAccountsApi.directory().then((people) => people.map(directoryRow))
    : staffAccountsApi.list(),
);
const accounts = computed(() => view.data.value ?? []);
// An empty list is an answer, not a missing page: the header and the add button stay.
const pageState = computed(() => (view.state.value === 'empty' ? 'ready' : view.state.value));

const query = ref('');
const role = ref<'all' | StaffRole>('all');
const status = ref<'all' | 'ACTIVE' | 'BLOCKED'>('all');

const rows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return accounts.value
    .filter((a) => role.value === 'all' || a.roles.includes(role.value))
    .filter((a) => status.value === 'all' || a.status === status.value)
    .filter(
      (a) => needle === '' || `${a.fullName} ${a.login ?? ''}`.toLowerCase().includes(needle),
    );
});

const countWithRole = (r: StaffRole): number =>
  accounts.value.filter((a) => a.roles.includes(r)).length;
const activeCount = computed(() => accounts.value.filter((a) => a.status === 'ACTIVE').length);

const roleOptions = computed(() => [
  { value: 'all', label: t('staffUsers.accounts.filters.all'), count: accounts.value.length },
  ...STAFF_ROLES.map((r) => ({ value: r, label: t(`roles.staff.${r}`), count: countWithRole(r) })),
]);
const statusOptions = computed(() => [
  { value: 'all', label: t('staffUsers.accounts.filters.all') },
  { value: 'ACTIVE', label: t('staffUsers.accounts.status.ACTIVE') },
  { value: 'BLOCKED', label: t('staffUsers.accounts.status.BLOCKED') },
]);

// v8 role tiles: one per staff role, with its head count; a tile is a shortcut for the role filter.
const ROLE_ICONS: Readonly<Record<StaffRole, StaffIconName>> = {
  ADMIN: 'shield',
  MANAGER: 'usercheck',
  ACCOUNTANT: 'calc',
  WAREHOUSE_MANAGER: 'warehouse',
  DRIVER: 'truck',
  PURCHASING_MANAGER: 'package',
};
const roleTiles = computed(() =>
  STAFF_ROLES.map((r) => ({ role: r, icon: ROLE_ICONS[r], count: countWithRole(r) })),
);
function pickRole(r: StaffRole): void {
  role.value = role.value === r ? 'all' : r;
}

const columns = computed<DataTableColumn<StaffAccountResponse>[]>(() => {
  const all: DataTableColumn<StaffAccountResponse>[] = [
    {
      key: 'name',
      label: t('staffUsers.accounts.columns.name'),
      truncate: true,
      text: (a) => a.fullName,
      compare: (a, b) => a.fullName.localeCompare(b.fullName),
    },
    { key: 'roles', label: t('staffUsers.accounts.columns.roles') },
    { key: 'telegram', label: t('staffUsers.accounts.columns.telegram'), width: '120px' },
    { key: 'password', label: t('staffUsers.accounts.columns.password'), width: '130px' },
    {
      key: 'lastSignIn',
      label: t('staffUsers.accounts.columns.lastSignIn'),
      width: '150px',
      text: (a) =>
        a.lastSignInAt ? formatDateTime(a.lastSignInAt) : t('staffUsers.accounts.neverSignedIn'),
      compare: (a, b) => (a.lastSignInAt ?? '').localeCompare(b.lastSignInAt ?? ''),
      hasSortValue: (a) => a.lastSignInAt !== null,
    },
    { key: 'status', label: t('staffUsers.accounts.columns.status'), width: '120px' },
    {
      key: 'actions',
      label: t('staffUsers.accounts.columns.actions'),
      width: '76px',
      hideOnCard: true,
    },
  ];
  return readOnly.value ? all.filter((c) => !CREDENTIAL_COLUMNS.includes(c.key)) : all;
});

function replace(next: StaffAccountResponse): void {
  const list = view.data.value ?? [];
  view.data.value = list.some((a) => a.id === next.id)
    ? list.map((a) => (a.id === next.id ? next : a))
    : [...list, next];
}

// --- dialogs -------------------------------------------------------------------------------
const createOpen = ref(false);
const telegramFor = ref<StaffAccountResponse | null>(null);
// Kept after closing so the dialog can play its exit animation (it holds a one-time password).
const credentialsFor = ref<StaffAccountResponse | null>(null);
const credentialsShown = ref(false);
const telegramOpen = computed({
  get: () => telegramFor.value !== null,
  set: (open: boolean) => {
    if (!open) telegramFor.value = null;
  },
});
const credentialsOpen = computed({
  get: () => credentialsShown.value,
  set: (open: boolean) => {
    credentialsShown.value = open;
  },
});

function askCredentials(account: StaffAccountResponse): void {
  credentialsFor.value = account;
  credentialsShown.value = true;
}

function onCredentialsSaved(login: string): void {
  const current = credentialsFor.value;
  if (current) replace({ ...current, login, hasPassword: true });
}

// --- block / unblock of a staff account ---------------------------------------------------
const statusChange = ref<{ account: StaffAccountResponse; block: boolean } | null>(null);
const statusBusy = ref(false);
const statusError = ref<string | null>(null);
const statusOpen = computed({
  get: () => statusChange.value !== null,
  set: (open: boolean) => {
    if (!open && !statusBusy.value) statusChange.value = null;
  },
});

function askStatus(account: StaffAccountResponse, block: boolean): void {
  statusError.value = null;
  statusChange.value = { account, block };
}

async function confirmStatus(): Promise<void> {
  const change = statusChange.value;
  if (!change || statusBusy.value) return;
  statusBusy.value = true;
  statusError.value = null;
  try {
    // A staff member is never removed from Telegram groups, so the flag stays off.
    if (change.block) await staffUsersApi.blockUser(change.account.id, { removeFromGroups: false });
    else await staffUsersApi.unblockUser(change.account.id);
    replace({ ...change.account, status: change.block ? 'BLOCKED' : 'ACTIVE' });
    showToast({
      message: t(
        change.block
          ? 'staffUsers.accounts.blockDialog.blocked'
          : 'staffUsers.accounts.blockDialog.unblocked',
        { name: change.account.fullName },
      ),
    });
    statusChange.value = null;
  } catch (caught) {
    const text = errorTextFor(caught);
    // The dialog stays open with the message: reloading the list would unmount it.
    statusError.value = t(`staffUsers.errors.${text.key}`, { ...text.params });
  } finally {
    statusBusy.value = false;
  }
}

const mayChange = (a: StaffAccountResponse): boolean => mayChangeAccount(viewerRoles.value, a);

// The row menu offers exactly what the viewer may do (UI convenience; the server decides).
function menuItems(a: StaffAccountResponse): RowMenuItem[] {
  const items: RowMenuItem[] = [
    {
      key: 'telegram',
      label: t('staffUsers.accounts.actions.telegram'),
      icon: 'send',
      testid: 'account-telegram',
      run: () => (telegramFor.value = a),
    },
    {
      key: 'credentials',
      label: t('staffUsers.accounts.actions.credentials'),
      icon: 'key',
      testid: 'account-credentials',
      run: () => askCredentials(a),
    },
  ];
  if (mayBlock.value) {
    const block = a.status === 'ACTIVE';
    items.push({
      key: 'status',
      label: t(`staffUsers.accounts.actions.${block ? 'block' : 'unblock'}`),
      icon: 'lock',
      danger: block,
      testid: 'account-status',
      run: () => askStatus(a, block),
    });
  }
  return items;
}
const menuLabel = (a: StaffAccountResponse): string =>
  t('staffUsers.accounts.actions.menu', { name: a.fullName });
</script>

<template>
  <StateView :state="pageState" @retry="view.reload()">
    <div class="accounts">
      <header class="head">
        <div class="head__text">
          <h1 class="head__title">{{ t('staffUsers.accounts.title') }}</h1>
          <p class="head__sub">
            {{ t('staffUsers.accounts.subtitle') }} ·
            <span class="head__info">{{
              t('staffUsers.accounts.info', { count: accounts.length })
            }}</span>
          </p>
        </div>
        <AppButton v-if="!readOnly" size="lg" data-testid="add-account" @click="createOpen = true">
          <StaffIcon name="userplus" :size="16" />
          {{ t('staffUsers.accounts.add') }}
        </AppButton>
      </header>

      <div class="tiles" role="group" :aria-label="t('staffUsers.accounts.roleTiles.label')">
        <button
          v-for="tile in roleTiles"
          :key="tile.role"
          type="button"
          class="tile"
          :class="{ 'tile--on': role === tile.role }"
          :aria-pressed="role === tile.role"
          :data-role-tile="tile.role"
          @click="pickRole(tile.role)"
        >
          <span class="tile__top">
            <StaffIcon :name="tile.icon" :size="18" class="tile__icon" />
            <span class="tile__count">{{
              t('staffUsers.accounts.roleTiles.count', { count: tile.count })
            }}</span>
          </span>
          <span class="tile__name">{{ t(`roles.staff.${tile.role}`) }}</span>
          <span class="tile__hint">{{ t(`staffUsers.accounts.roleTiles.hint.${tile.role}`) }}</span>
        </button>
      </div>

      <FilterPanel :aria-label="t('staffUsers.accounts.filters.group')">
        <SearchField
          v-model="query"
          class="search"
          :placeholder="t('staffUsers.accounts.search')"
        />
        <FilterField :label="t('staffUsers.accounts.filters.role')">
          <AppDropdown
            :model-value="role"
            :options="roleOptions"
            :label="t('staffUsers.accounts.filters.role')"
            min-width="190px"
            @update:model-value="role = $event as typeof role"
          />
        </FilterField>
        <FilterField :label="t('staffUsers.accounts.filters.status')">
          <AppDropdown
            :model-value="status"
            :options="statusOptions"
            :label="t('staffUsers.accounts.filters.status')"
            min-width="160px"
            @update:model-value="status = $event as typeof status"
          />
        </FilterField>
        <span class="summary">{{
          t('staffUsers.accounts.summary', {
            active: activeCount,
            blocked: accounts.length - activeCount,
          })
        }}</span>
      </FilterPanel>

      <DataTable
        :columns="columns"
        :rows="rows"
        :row-key="(a: StaffAccountResponse) => a.id"
        :label="t('staffUsers.accounts.list')"
        :empty-text="
          accounts.length === 0
            ? t('staffUsers.accounts.empty')
            : t('staffUsers.accounts.emptyFiltered')
        "
      >
        <template #cell-name="{ row }">
          <span class="person">
            <PersonAvatar :name="row.fullName" />
            <span class="person__text">
              <span class="name"><PersonName :name="row.fullName" :user-id="row.id" /></span>
              <span v-if="!readOnly" class="login">{{
                row.login ?? t('staffUsers.accounts.noLogin')
              }}</span>
            </span>
          </span>
        </template>
        <template #cell-roles="{ row }"><StaffRoleBadges :roles="row.roles" /></template>
        <template #cell-status="{ row }">
          <AppBadge :tone="row.status === 'ACTIVE' ? 'success' : 'danger'" dot>
            {{ t(`staffUsers.accounts.status.${row.status}`) }}
          </AppBadge>
        </template>
        <template #cell-password="{ row }">
          <AppBadge :tone="row.hasPassword ? 'neutral' : 'muted'">
            {{
              row.hasPassword
                ? t('staffUsers.accounts.password.set')
                : t('staffUsers.accounts.password.notSet')
            }}
          </AppBadge>
        </template>
        <template #cell-telegram="{ row }">
          <AppBadge :tone="row.telegramLinked ? 'info' : 'muted'">
            {{
              row.telegramLinked
                ? t('staffUsers.accounts.telegram.linked')
                : t('staffUsers.accounts.telegram.notLinked')
            }}
          </AppBadge>
        </template>
        <template #cell-lastSignIn="{ row }">
          <span class="meta">{{
            row.lastSignInAt
              ? formatDateTime(row.lastSignInAt)
              : t('staffUsers.accounts.neverSignedIn')
          }}</span>
        </template>
        <template #cell-actions="{ row }">
          <!-- A manager on an administrator's row: no actions, a lock that says why. -->
          <span
            v-if="!mayChange(row)"
            class="locked"
            :title="t('staffUsers.accounts.forbiddenNote')"
          >
            <StaffIcon name="lock" :size="15" />
            <span class="sr-only">{{ t('staffUsers.accounts.forbiddenNote') }}</span>
          </span>
          <AccountRowMenu v-else :items="menuItems(row)" :label="menuLabel(row)" />
        </template>
        <template #card="{ row }">
          <span class="card__top">
            <span class="person">
              <PersonAvatar :name="row.fullName" />
              <span class="person__text">
                <span class="name"><PersonName :name="row.fullName" :user-id="row.id" /></span>
                <span v-if="!readOnly" class="login">{{
                  row.login ?? t('staffUsers.accounts.noLogin')
                }}</span>
              </span>
            </span>
            <AccountRowMenu
              v-if="!readOnly && mayChange(row)"
              :items="menuItems(row)"
              :label="menuLabel(row)"
            />
          </span>
          <span class="facts">
            <StaffRoleBadges :roles="row.roles" />
            <AppBadge :tone="row.status === 'ACTIVE' ? 'success' : 'danger'" dot>
              {{ t(`staffUsers.accounts.status.${row.status}`) }}
            </AppBadge>
          </span>
          <span v-if="!readOnly" class="facts">
            <AppBadge :tone="row.hasPassword ? 'neutral' : 'muted'">
              {{ t('staffUsers.accounts.columns.password') }}:
              {{
                row.hasPassword
                  ? t('staffUsers.accounts.password.set')
                  : t('staffUsers.accounts.password.notSet')
              }}
            </AppBadge>
            <AppBadge :tone="row.telegramLinked ? 'info' : 'muted'">
              {{ t('staffUsers.accounts.columns.telegram') }}:
              {{
                row.telegramLinked
                  ? t('staffUsers.accounts.telegram.linked')
                  : t('staffUsers.accounts.telegram.notLinked')
              }}
            </AppBadge>
          </span>
          <span v-if="!readOnly" class="meta">
            {{ t('staffUsers.accounts.columns.lastSignIn') }}:
            {{
              row.lastSignInAt
                ? formatDateTime(row.lastSignInAt)
                : t('staffUsers.accounts.neverSignedIn')
            }}
          </span>
          <span v-if="!mayChange(row)" class="note">
            <StaffIcon name="lock" :size="13" />
            {{ t('staffUsers.accounts.forbiddenNote') }}
          </span>
        </template>
      </DataTable>

      <CreateStaffAccountDialog
        v-model="createOpen"
        :viewer-roles="viewerRoles"
        @created="replace"
      />
      <StaffTelegramDialog
        v-if="telegramFor"
        v-model="telegramOpen"
        :account="telegramFor"
        @saved="replace"
      />
      <StaffCredentialsDialog
        v-if="credentialsFor"
        v-model="credentialsOpen"
        :account="credentialsFor"
        @saved="onCredentialsSaved"
      />
      <AppConfirmDialog
        v-model="statusOpen"
        :title="
          statusChange?.block
            ? t('staffUsers.accounts.blockDialog.title', { name: statusChange.account.fullName })
            : t('staffUsers.accounts.blockDialog.unblockTitle', {
                name: statusChange?.account.fullName ?? '',
              })
        "
        :description="
          statusChange?.block
            ? t('staffUsers.accounts.blockDialog.description')
            : t('staffUsers.accounts.blockDialog.unblockDescription')
        "
        :confirm-label="
          statusChange?.block
            ? t('staffUsers.accounts.blockDialog.confirm')
            : t('staffUsers.accounts.blockDialog.unblockConfirm')
        "
        :tone="statusChange?.block ? 'danger' : 'primary'"
        :loading="statusBusy"
        :error="statusError"
        @confirm="confirmStatus"
      />
    </div>
  </StateView>
</template>

<style scoped>
.accounts {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: viewIn 0.35s var(--ease) both;
}

/* v8 page header: 28px regular title, 12px grey line under it, actions on the right. */
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

.head__sub {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* v8 role tiles: white hairline cards; the picked one is accent-tinted with an accent ring. */
/* Six roles: one row of six on a wide screen, else rows of three (two on a phone, below), so a
   tile is never left alone on a row. */
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

@media (min-width: 1280px) {
  .tiles {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 12px;
  }

  /* The child selector outranks the base .tile rule further down. */
  .tiles > .tile {
    padding: 16px;
  }
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px;
  border: none;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.tile:hover {
  background: var(--hov);
}

.tile--on,
.tile--on:hover {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
}

.tile__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tile__icon {
  color: var(--t2);
}

.tile--on .tile__icon {
  color: var(--acc);
}

.tile__count {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.tile__name {
  margin-top: 6px;
  font-size: var(--fs-section);
  font-weight: 600;
}

.tile__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.search {
  flex: 1 1 240px;
  max-width: 316px;
}

.summary {
  align-self: center;
  margin-left: auto;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.person {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.person__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name {
  font-size: var(--fs-small);
  overflow: hidden;
  text-overflow: ellipsis;
}

.login {
  font-size: var(--fs-group);
  color: var(--t2);
  overflow-wrap: anywhere;
}

.meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.locked {
  display: inline-flex;
  padding: 8px;
  color: var(--t3);
  cursor: help;
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 640px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .tile {
    padding: 14px;
  }

  .tile__hint {
    display: none;
  }

  .summary {
    width: 100%;
    margin-left: 0;
  }
}
</style>
