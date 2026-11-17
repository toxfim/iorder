<script setup lang="ts">
import type {
  ProductSuccession,
  ProductSuccessionDecision,
  ProductSuccessionProduct,
  ProductSuccessionStatus,
} from '@iorder/shared/staff-cost';
import { PRODUCT_SUCCESSION_STATUSES } from '@iorder/shared/staff-cost';
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import PricesSubHeader from '@/features/pricing/components/PricesSubHeader.vue';
import { canEditPrices } from '@/features/staff-shell/price-access';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppTabs from '@core/components/ui/AppTabs.vue';
import StateView from '@core/components/ui/StateView.vue';
import type { ViewState } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { useFormat } from '@core/i18n/use-format';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';

// "Yangi modellar" [C, owner 2026-11-09]: the system proposes (older model -> newer model) pairs
// from product names; a manager or admin confirms or rejects each one here. Only a confirmed pair
// ever reaches a customer (the "Yangi model" hero of the customer home). UI convenience only: the
// api refuses every change of the other roles.
const { t } = useI18n();
const { successionsApi, currentUser } = useServices();
const { formatShortDateTime } = useFormat();
const canDecide = computed(() => canEditPrices(currentUser.user.value?.staffRoles ?? []));

const PANEL_ID = 'newer-models-panel';
const status = ref<ProductSuccessionStatus>('PROPOSED');
const state = ref<ViewState>('loading');
const loadError = shallowRef<unknown>(null);
const items = shallowRef<readonly ProductSuccession[]>([]);
const counts = ref<Record<ProductSuccessionStatus, number>>({
  PROPOSED: 0,
  CONFIRMED: 0,
  REJECTED: 0,
});
/** Pairs whose decision is being saved (their buttons lock meanwhile). */
const saving = reactive(new Set<string>());
const finding = ref(false);
let loadRun = 0;

async function load(): Promise<void> {
  const mine = ++loadRun;
  state.value = 'loading';
  loadError.value = null;
  try {
    const answer = await successionsApi.list(status.value);
    if (mine !== loadRun) return;
    items.value = answer.items;
    counts.value = answer.counts;
    state.value = answer.items.length === 0 ? 'empty' : 'ready';
  } catch (caught) {
    if (mine !== loadRun) return;
    loadError.value = caught;
    state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}
void load();
watch(status, () => void load());

const errorText = (caught: unknown): string =>
  translateDescribed(t, describePricingError('load', caught));

const tabs = computed(() =>
  PRODUCT_SUCCESSION_STATUSES.map((id) => ({
    id,
    label: t(`newerModels.tabs.${id}`),
    count: counts.value[id],
  })),
);
function selectTab(id: string): void {
  if ((PRODUCT_SUCCESSION_STATUSES as readonly string[]).includes(id)) {
    status.value = id as ProductSuccessionStatus;
  }
}

async function findProposals(): Promise<void> {
  finding.value = true;
  try {
    const { proposedCount } = await successionsApi.findProposals();
    showToast({
      message:
        proposedCount === 0
          ? t('newerModels.foundNone')
          : t('newerModels.found', { count: proposedCount }),
    });
    if (proposedCount > 0) {
      status.value = 'PROPOSED';
      await load();
    }
  } catch (caught) {
    showToast({ message: errorText(caught) });
  } finally {
    finding.value = false;
  }
}

async function decide(pair: ProductSuccession, decision: ProductSuccessionDecision): Promise<void> {
  saving.add(pair.id);
  try {
    await successionsApi.decide(pair.id, decision);
    const names = { older: pair.older.name, newer: pair.newer.name };
    showToast({
      message:
        decision === 'CONFIRMED'
          ? t('newerModels.confirmed', names)
          : t('newerModels.rejected', names),
    });
    // The pair left this tab: the list and the counts are read again.
    await load();
  } catch (caught) {
    showToast({ message: errorText(caught) });
    if (caught instanceof ApiNotFoundError) void load();
  } finally {
    saving.delete(pair.id);
  }
}

const columns = computed<DataTableColumn<ProductSuccession>[]>(() => [
  {
    key: 'older',
    label: t('newerModels.columns.older'),
    minWidth: '220px',
    text: (row) => row.older.name,
    compare: (a, b) => a.older.name.localeCompare(b.older.name),
  },
  {
    key: 'newer',
    label: t('newerModels.columns.newer'),
    minWidth: '220px',
    text: (row) => row.newer.name,
    compare: (a, b) => a.newer.name.localeCompare(b.newer.name),
  },
  { key: 'decision', label: t('newerModels.columns.decision'), width: '280px' },
]);

const decidedLine = (row: ProductSuccession): string | null =>
  row.decidedAt === null
    ? null
    : t('newerModels.decidedBy', {
        name: row.decidedBy ?? '',
        date: formatShortDateTime(row.decidedAt),
      });
/** What makes a side unfit for a customer right now: not priced, or withdrawn. */
const sideNote = (side: ProductSuccessionProduct): string | null =>
  !side.isActive ? t('newerModels.inactive') : side.priced ? null : t('newerModels.notPriced');
const labelFor = (row: ProductSuccession, decision: ProductSuccessionDecision): string =>
  t(decision === 'CONFIRMED' ? 'newerModels.confirmLabel' : 'newerModels.rejectLabel', {
    older: row.older.name,
    newer: row.newer.name,
  });
</script>

<template>
  <section class="newer-models">
    <PricesSubHeader
      :title="t('newerModels.title')"
      :subtitle="t('newerModels.subtitle', { count: counts.PROPOSED })"
    >
      <template #actions>
        <AppButton
          v-if="canDecide"
          variant="secondary"
          :loading="finding"
          data-testid="find-proposals"
          @click="findProposals()"
        >
          <StaffIcon name="search" :size="16" />{{ t('newerModels.find') }}
        </AppButton>
      </template>
    </PricesSubHeader>

    <p class="note" role="note">
      <StaffIcon name="star" :size="16" class="note__icon" />
      <span>{{ t('newerModels.explanation') }}</span>
    </p>

    <AppTabs
      :model-value="status"
      :tabs="tabs"
      :label="t('newerModels.tabs.label')"
      id-prefix="newer-models"
      :panel-id="PANEL_ID"
      @update:model-value="selectTab"
    />

    <div :id="PANEL_ID" role="tabpanel" :aria-labelledby="`newer-models-tab-${status}`">
      <StateView
        :state="state"
        :title="state === 'empty' ? t(`newerModels.empty.${status}.title`) : undefined"
        :description="
          state === 'empty'
            ? t(`newerModels.empty.${status}.description`)
            : state === 'error'
              ? errorText(loadError)
              : undefined
        "
        @retry="load()"
      >
        <DataTable
          :columns="columns"
          :rows="items"
          :row-key="(row: ProductSuccession) => row.id"
          :label="t('newerModels.tableLabel')"
          :empty-text="t(`newerModels.empty.${status}.title`)"
          :density-toggle="false"
        >
          <template #cell-older="{ row }">
            <span class="product">
              <span class="product__line">
                <span class="name">{{ row.older.name }}</span>
                <AppBadge v-if="sideNote(row.older)" tone="muted">{{
                  sideNote(row.older)
                }}</AppBadge>
              </span>
              <span class="meta mono">{{ row.older.productCode }}</span>
            </span>
          </template>
          <template #cell-newer="{ row }">
            <span class="product">
              <span class="product__line">
                <StaffIcon name="arrow" :size="14" class="product__arrow" />
                <span class="name">{{ row.newer.name }}</span>
                <AppBadge v-if="sideNote(row.newer)" tone="warning">{{
                  sideNote(row.newer)
                }}</AppBadge>
              </span>
              <span class="meta mono">{{ row.newer.productCode }}</span>
            </span>
          </template>
          <template #cell-decision="{ row }">
            <span class="decision">
              <span v-if="decidedLine(row)" class="meta" data-testid="decided-line">
                {{ decidedLine(row) }}
              </span>
              <span v-if="canDecide" class="decision__actions">
                <AppButton
                  v-if="row.status !== 'CONFIRMED'"
                  size="sm"
                  :loading="saving.has(row.id)"
                  :aria-label="labelFor(row, 'CONFIRMED')"
                  data-testid="confirm-pair"
                  @click="decide(row, 'CONFIRMED')"
                >
                  <StaffIcon name="check" :size="14" />{{ t('newerModels.confirm') }}
                </AppButton>
                <AppButton
                  v-if="row.status !== 'REJECTED'"
                  variant="secondary"
                  size="sm"
                  :loading="saving.has(row.id)"
                  :aria-label="labelFor(row, 'REJECTED')"
                  data-testid="reject-pair"
                  @click="decide(row, 'REJECTED')"
                >
                  <StaffIcon name="x" :size="14" />{{ t('newerModels.reject') }}
                </AppButton>
              </span>
              <span v-else-if="row.status === 'PROPOSED'" class="meta">
                {{ t('newerModels.readOnly') }}
              </span>
            </span>
          </template>
          <template #card="{ row }">
            <span class="card">
              <span class="product__line">
                <b class="name">{{ row.older.name }}</b>
                <AppBadge v-if="sideNote(row.older)" tone="muted">{{
                  sideNote(row.older)
                }}</AppBadge>
              </span>
              <span class="product__line">
                <StaffIcon name="arrow" :size="14" class="product__arrow" />
                <b class="name">{{ row.newer.name }}</b>
                <AppBadge v-if="sideNote(row.newer)" tone="warning">{{
                  sideNote(row.newer)
                }}</AppBadge>
              </span>
              <span class="meta">
                <span class="mono">{{ row.older.productCode }}</span>
                <span aria-hidden="true">→</span>
                <span class="mono">{{ row.newer.productCode }}</span>
              </span>
              <span v-if="decidedLine(row)" class="meta">{{ decidedLine(row) }}</span>
              <span v-if="canDecide" class="decision__actions">
                <AppButton
                  v-if="row.status !== 'CONFIRMED'"
                  size="sm"
                  :loading="saving.has(row.id)"
                  :aria-label="labelFor(row, 'CONFIRMED')"
                  @click="decide(row, 'CONFIRMED')"
                >
                  <StaffIcon name="check" :size="14" />{{ t('newerModels.confirm') }}
                </AppButton>
                <AppButton
                  v-if="row.status !== 'REJECTED'"
                  variant="secondary"
                  size="sm"
                  :loading="saving.has(row.id)"
                  :aria-label="labelFor(row, 'REJECTED')"
                  @click="decide(row, 'REJECTED')"
                >
                  <StaffIcon name="x" :size="14" />{{ t('newerModels.reject') }}
                </AppButton>
              </span>
            </span>
          </template>
        </DataTable>
      </StateView>
    </div>
  </section>
</template>

<style scoped>
.newer-models {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  color: var(--t2);
  font-size: var(--fs-small);
  line-height: 1.5;
}

.note__icon {
  flex: none;
  margin-top: 1px;
  color: var(--acc);
}

.product,
.card,
.decision {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.card {
  gap: 6px;
}

.product__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.product__arrow {
  flex: none;
  color: var(--t3);
}

.name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--t3);
}

.decision {
  gap: 8px;
}

.decision__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
