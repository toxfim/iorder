<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SupplyRemovalRequest } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StateView from '@core/components/ui/StateView.vue';
import { showToast } from '@core/composables/use-toast';
import { useAsyncView } from '@core/composables/use-async-view';
import { describePricingError } from '@core/lib/price-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { useCostFormat } from '../composables/use-cost-format';

// Delivery lines that vanished from the sheet. Nothing is deleted without a manager: confirming
// removes the line from stock and cost history (the row stays stored), dismissing keeps it.
// The accountant sees the list but not the buttons.
defineProps<{ canDecide: boolean }>();
const emit = defineEmits<{ decided: [] }>();

const { t } = useI18n();
const { stockApi, sheetAttentionStore } = useServices();
const { formatUsd, formatUzsWithCurrency, formatRate, formatQuantity, formatDate } =
  useCostFormat();

const view = useAsyncView(() => stockApi.listSupplyRemovals(), {
  isEmpty: (list) => list.items.length === 0,
});

const items = computed(() => view.data.value?.items ?? []);
// The nav badge shows the same number: tell it what this page just read or decided.
watch(
  () => view.data.value?.total,
  (total) => {
    if (total !== undefined) sheetAttentionStore.setRemovals(total);
  },
);
const errorText = computed(() =>
  translateDescribed(t, describePricingError('removal', view.error.value)),
);

const busyId = ref<string | null>(null);
const confirmTarget = ref<SupplyRemovalRequest | null>(null);
const confirmError = ref<string | null>(null);
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (open: boolean) => {
    if (!open) confirmTarget.value = null;
  },
});

async function decide(
  request: SupplyRemovalRequest,
  action: 'confirm' | 'dismiss',
): Promise<boolean> {
  busyId.value = request.id;
  try {
    if (action === 'confirm') await stockApi.confirmSupplyRemoval(request.id);
    else await stockApi.dismissSupplyRemoval(request.id);
    showToast({
      message: t(
        action === 'confirm'
          ? 'staffCost.removals.confirmedToast'
          : 'staffCost.removals.dismissedToast',
        { id: request.deliveryRef },
      ),
    });
    emit('decided');
    await view.reload();
    return true;
  } catch (caught) {
    const text = translateDescribed(t, describePricingError('removal', caught));
    if (action === 'confirm') confirmError.value = text;
    else showToast({ message: text });
    // Someone else may have decided it already: show the current list either way.
    void view.reload();
    return false;
  } finally {
    busyId.value = null;
  }
}

async function confirmRemoval(): Promise<void> {
  const target = confirmTarget.value;
  if (!target) return;
  confirmError.value = null;
  if (await decide(target, 'confirm')) confirmTarget.value = null;
}

function askConfirm(request: SupplyRemovalRequest): void {
  confirmError.value = null;
  confirmTarget.value = request;
}
</script>

<template>
  <section class="removals" :aria-label="t('staffCost.removals.title')">
    <h3 class="removals__title">
      {{ t('staffCost.removals.title') }}
      <span v-if="view.data.value && view.data.value.total > 0" class="removals__count">
        {{ view.data.value.total }}
      </span>
    </h3>
    <p class="removals__help">{{ t('staffCost.removals.help') }}</p>

    <StateView
      :state="view.state.value"
      :title="view.state.value === 'empty' ? t('staffCost.removals.empty') : undefined"
      :description="view.state.value === 'error' ? errorText : undefined"
      @retry="view.reload"
    >
      <ul class="removals__list">
        <li
          v-for="request in items"
          :key="request.id"
          class="request"
          data-testid="removal-request"
        >
          <div class="request__head">
            <span class="mono request__code">{{ request.productCode }}</span>
            <span class="mono request__ref">{{ request.deliveryRef }}</span>
            <span class="request__detected">
              {{ t('staffCost.removals.detected', { date: formatDate(request.detectedAt) }) }}
            </span>
          </div>
          <dl class="request__facts">
            <div>
              <dt>{{ t('staffCost.supply.date') }}</dt>
              <dd class="num">{{ formatDate(request.line.deliveredAt) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.supplier') }}</dt>
              <dd>{{ request.line.supplier }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.delivered') }}</dt>
              <dd class="num">{{ formatQuantity(request.line.deliveredQuantity) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.available') }}</dt>
              <dd class="num">{{ formatQuantity(request.line.availableQuantity) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.usd') }}</dt>
              <dd class="num">{{ formatUsd(request.line.costUsd) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.rate') }}</dt>
              <dd class="num">{{ formatRate(request.line.usdRateUsed) }}</dd>
            </div>
            <div>
              <dt>{{ t('staffCost.supply.uzs') }}</dt>
              <dd class="num">{{ formatUzsWithCurrency(request.line.costUzs) }}</dd>
            </div>
          </dl>
          <div v-if="canDecide" class="request__actions">
            <AppButton
              size="xs"
              :disabled="busyId !== null"
              :aria-label="`${t('staffCost.removals.confirm')}: ${request.productCode} ${request.deliveryRef}`"
              @click="askConfirm(request)"
            >
              {{ t('staffCost.removals.confirm') }}
            </AppButton>
            <AppButton
              variant="secondary"
              size="xs"
              :loading="busyId === request.id"
              :disabled="busyId !== null && busyId !== request.id"
              :aria-label="`${t('staffCost.removals.dismiss')}: ${request.productCode} ${request.deliveryRef}`"
              @click="decide(request, 'dismiss')"
            >
              {{ t('staffCost.removals.dismiss') }}
            </AppButton>
          </div>
        </li>
      </ul>
    </StateView>

    <AppConfirmDialog
      v-model="confirmOpen"
      tone="danger"
      :title="t('staffCost.removals.confirmTitle', { id: confirmTarget?.deliveryRef ?? '' })"
      :description="t('staffCost.removals.confirmDescription')"
      :confirm-label="t('staffCost.removals.confirmAction')"
      :loading="busyId !== null"
      :error="confirmError"
      @confirm="confirmRemoval"
    />
  </section>
</template>

<style scoped>
/* A v8 card: 15px/600 title with an accent count chip, 11px help, hairline-ruled requests. */
.removals {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.removals__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 20px 20px 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.removals__count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-group);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.removals__help {
  margin: 0;
  padding: 0 20px 16px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.removals__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.request {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
}

.request__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}

.request__code {
  font-size: var(--fs-small);
  font-weight: 600;
}

.request__ref {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.request__detected {
  margin-left: auto;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.request__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px 12px;
  margin: 0;
}

.request__facts dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.request__facts dd {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.request__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Empty, error and loading states sit inside the card: a smaller margin than on a page. */
.removals :deep(.state) {
  margin: 24px auto 28px;
  padding: 0 20px;
}
</style>
