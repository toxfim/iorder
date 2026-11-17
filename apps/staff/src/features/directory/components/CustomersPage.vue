<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterCombobox from '@/components/ui/FilterCombobox.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { formatPhone } from '@core/lib/phone';
import PersonName from '@/features/people/components/PersonName.vue';
import {
  ALL_ORGANIZATIONS,
  filterPeople,
  peopleFiltersFromQuery,
  peopleRows,
  queryOfPeopleFilters,
  type PeopleKindFilter,
  type PeopleStatusFilter,
  type PersonRow,
} from '../domain/people-list';
import { forgetCustomersList, rememberCustomersList } from '../composables/customers-list-memory';
import ActiveBadge from './ActiveBadge.vue';
import PersonAvatar from './PersonAvatar.vue';

// Mijozlar = the customers' PEOPLE [owner 2026-11-13]: shop owners and sellers of the groups and
// the customers of PERSON organizations, each with their organization. The organizations
// themselves are on Tashkilotlar.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { directoryStore } = useServices();
const phone = useMediaQuery('(max-width: 640px)', false);
const filterMinWidth = (desktop: string): string => (phone.value ? '0' : desktop);

// The filters live in the URL query (replace, not push: typing is not history), so a reload, the
// way back from a person and a link from an organization ("its people") show the same list.
const initial = peopleFiltersFromQuery(route.query);
const query = ref(initial.search);
const organization = ref(initial.organization);
const kind = ref<PeopleKindFilter>(initial.kind);
const status = ref<PeopleStatusFilter>(initial.status);
const onThisPage = (): boolean => route.name === 'staff-customers';
// A person opened from here comes back to this list as it was (its filters), not to their
// organization card.
onBeforeRouteLeave((to, from) => {
  if (to.name === 'staff-member') rememberCustomersList(from.fullPath);
  else forgetCustomersList();
});
watch([query, organization, kind, status], ([search, org, nextKind, nextStatus]) => {
  if (!onThisPage()) return;
  void router.replace({
    query: queryOfPeopleFilters({
      search,
      organization: org,
      kind: nextKind,
      status: nextStatus,
    }),
  });
});
watch(
  () => route.query,
  (next) => {
    if (!onThisPage()) return;
    const filters = peopleFiltersFromQuery(next);
    query.value = filters.search;
    organization.value = filters.organization;
    kind.value = filters.kind;
    status.value = filters.status;
  },
);

const all = computed(() =>
  peopleRows(directoryStore.members.value, directoryStore.organizations.value),
);
const rows = computed(() =>
  filterPeople(all.value, {
    search: query.value,
    organization: organization.value,
    kind: kind.value,
    status: status.value,
  }),
);
// Only organizations that have people are worth filtering by; each says how many.
const organizationOptions = computed(() => {
  const counts = new Map<string, number>();
  for (const row of all.value) {
    counts.set(row.organization.id, (counts.get(row.organization.id) ?? 0) + 1);
  }
  return directoryStore.organizations.value
    .filter((o) => counts.has(o.id))
    .map((o) => ({
      value: o.id,
      label: o.type === 'PERSON' ? `${o.name} · ${t('customers.people.personBadge')}` : o.name,
      count: counts.get(o.id) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});
const organizationCount = computed(() => organizationOptions.value.length);

const isPerson = (row: PersonRow): boolean => row.organization.type === 'PERSON';
const kindOptions = computed(() => [
  { value: 'all', label: t('customers.filters.all'), count: all.value.length },
  {
    value: 'members',
    label: t('customers.people.kinds.members'),
    count: all.value.filter((r) => !isPerson(r)).length,
  },
  {
    value: 'persons',
    label: t('customers.people.kinds.persons'),
    count: all.value.filter(isPerson).length,
  },
]);
const statusOptions = computed(() => [
  { value: 'all', label: t('customers.filters.all'), count: all.value.length },
  {
    value: 'active',
    label: t('customers.filters.active'),
    count: all.value.filter((r) => r.member.isActive).length,
  },
  {
    value: 'blocked',
    label: t('customers.filters.blocked'),
    count: all.value.filter((r) => !r.member.isActive).length,
  },
]);

// A PERSON customer is the organization itself: "Do'kon egasi" would mislead, and the
// organization column already says "Shaxs", so the role stays empty.
const roleText = (row: PersonRow): string =>
  isPerson(row) ? '' : t(`roles.organization.${row.member.role}`);
const phoneText = (row: PersonRow): string =>
  row.member.phone === '' ? '—' : formatPhone(row.member.phone);

const columns = computed<DataTableColumn<PersonRow>[]>(() => [
  {
    key: 'name',
    label: t('customers.people.columns.person'),
    truncate: true,
    minWidth: '200px',
    text: (r) => r.member.name,
    compare: (a, b) => a.member.name.localeCompare(b.member.name),
  },
  {
    key: 'phone',
    label: t('customers.people.columns.phone'),
    width: '170px',
    hideOnCard: true,
    text: phoneText,
  },
  {
    key: 'organization',
    label: t('customers.people.columns.organization'),
    truncate: true,
    width: '28%',
    text: (r) => r.organization.name,
    compare: (a, b) => a.organization.name.localeCompare(b.organization.name),
  },
  { key: 'role', label: t('customers.people.columns.role'), width: '140px', text: roleText },
  { key: 'status', label: t('customers.filters.status'), width: '130px' },
]);

// An empty directory still shows the page with the empty-list text.
const pageState = computed(() =>
  directoryStore.state.value === 'empty' ? 'ready' : directoryStore.state.value,
);
const emptyText = computed(() =>
  all.value.length === 0 ? t('customers.people.emptyAll') : t('customers.people.empty'),
);
</script>

<template>
  <StateView :state="pageState" @retry="directoryStore.load()">
    <div class="customers">
      <header class="head">
        <h1 class="head__title">{{ t('customers.title') }}</h1>
        <span class="head__info" data-testid="customers-info">
          {{ t('customers.people.info', { count: all.length }, all.length) }} ·
          {{
            t(
              'customers.people.organizationsCount',
              { count: organizationCount },
              organizationCount,
            )
          }}
        </span>
      </header>

      <FilterPanel class="filters" :aria-label="t('customers.filters.group')">
        <SearchField v-model="query" class="search" :placeholder="t('customers.people.search')" />
        <FilterField class="filters__org" :label="t('customers.people.organization')">
          <FilterCombobox
            v-model="organization"
            :options="organizationOptions"
            :all-value="ALL_ORGANIZATIONS"
            :all-label="t('customers.people.allOrganizations')"
            :label="t('customers.people.organization')"
            :placeholder="t('customers.people.organizationSearch')"
            :no-match-text="t('customers.people.organizationNoMatch')"
            :clear-label="t('customers.people.clearOrganization')"
            :unknown-label="t('customers.people.unknownOrganization')"
            :count-text="(count: number) => t('customers.people.peopleCount', { count }, count)"
            data-testid="organization-filter"
          />
        </FilterField>
        <FilterField :label="t('customers.people.kind')">
          <AppDropdown
            :model-value="kind"
            :options="kindOptions"
            :label="t('customers.people.kind')"
            :min-width="filterMinWidth('200px')"
            @update:model-value="kind = $event as PeopleKindFilter"
          />
        </FilterField>
        <FilterField :label="t('customers.filters.status')">
          <AppDropdown
            :model-value="status"
            :options="statusOptions"
            :label="t('customers.filters.status')"
            :min-width="filterMinWidth('160px')"
            @update:model-value="status = $event as PeopleStatusFilter"
          />
        </FilterField>
      </FilterPanel>

      <DataTable
        :columns="columns"
        :rows="rows"
        :row-key="(r: PersonRow) => r.member.id"
        :row-to="
          (r: PersonRow) => ({
            name: 'staff-member',
            params: { organizationId: r.organization.id, memberId: r.member.id },
          })
        "
        :label="t('customers.people.list')"
        :empty-text="emptyText"
      >
        <template #cell-name="{ row }">
          <span class="who">
            <PersonAvatar :name="row.member.name" />
            <span class="name"
              ><PersonName :name="row.member.name" :user-id="row.member.id"
            /></span>
          </span>
        </template>
        <template #cell-phone="{ row }">
          <span class="mono phone">{{ phoneText(row) }}</span>
        </template>
        <template #cell-organization="{ row }">
          <span class="org">
            <span class="org__name">{{ row.organization.name }}</span>
            <AppBadge v-if="isPerson(row)" tone="info" data-testid="person-badge">{{
              t('customers.people.personBadge')
            }}</AppBadge>
          </span>
        </template>
        <template #cell-role="{ row }">
          <span v-if="isPerson(row)" class="muted">—</span>
          <AppBadge v-else :tone="row.member.role === 'SHOP_OWNER' ? 'accent' : 'neutral'">{{
            roleText(row)
          }}</AppBadge>
        </template>
        <template #cell-status="{ row }">
          <ActiveBadge :active="row.member.isActive" />
        </template>
        <template #card="{ row }">
          <span class="card__top">
            <span class="who">
              <PersonAvatar :name="row.member.name" />
              <span class="name">{{ row.member.name }}</span>
            </span>
            <ActiveBadge :active="row.member.isActive" />
          </span>
          <span class="card__meta">
            <span class="org">
              <span class="org__name">{{ row.organization.name }}</span>
              <AppBadge v-if="isPerson(row)" tone="info">{{
                t('customers.people.personBadge')
              }}</AppBadge>
            </span>
          </span>
          <span class="card__meta">
            {{ roleText(row) }}
            <template v-if="row.member.phone !== ''">
              <template v-if="!isPerson(row)"> · </template
              ><span class="mono">{{ phoneText(row) }}</span></template
            >
          </span>
        </template>
      </DataTable>
    </div>
  </StateView>
</template>

<style scoped>
.customers {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: viewIn 0.35s var(--ease) both;
}

/* v8 page header: 28px regular title, 12px grey line under it. */
.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__info {
  font-size: var(--fs-small);
  color: var(--t2);
}

.search {
  flex: 1 1 240px;
  max-width: 340px;
}

.filters__org {
  flex: 1 1 240px;
  max-width: 320px;
}

.who {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.name {
  min-width: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

.phone {
  font-size: var(--fs-small);
  color: var(--t2);
}

.org {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.org__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.muted {
  color: var(--t2);
}

.card__meta {
  font-size: var(--fs-small);
  color: var(--t2);
}

/* Phone: the filters fill the width two to a row; the search and the organization get a row each. */
@media (max-width: 640px) {
  .filters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 14px;
  }

  .search,
  .filters__org {
    grid-column: 1 / -1;
    max-width: none;
  }
}
</style>
