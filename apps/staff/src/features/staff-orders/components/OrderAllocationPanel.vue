<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { showToast } from '@core/composables/use-toast';
import { useAllocationPlan } from '../composables/use-allocation-plan';
import { describeOrderError } from '../domain/order-errors';
import AllocationPlanPicker from './AllocationPlanPicker.vue';

// The manager's look at an approved order's holds: "not allocated" for an older order, a flag when a
// sync left a line below its holds, and the change with the ready FIFO alternative. Nothing changes
// by itself, the shipment itself may be why the sheet dropped. Supply details for the other roles
// come with the order page's allocation table (a later step).
const props = defineProps<{ orderId: string; rowVersion: number; status: string }>();
const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();
const { ordersApi } = useServices();
const summary = useAllocationPlan();
const change = useAllocationPlan();
const open = ref(false);
const busy = ref(false);

watch(
  () => [props.orderId, props.status] as const,
  () => void summary.load(props.orderId, 'CURRENT'),
  { immediate: true },
);

const preview = computed(() => summary.preview.value);

function startChange(): void {
  open.value = true;
  void change.load(props.orderId, 'CURRENT');
}

async function save(): Promise<void> {
  const choice = change.choice.value;
  if (choice === null || busy.value) return;
  busy.value = true;
  try {
    await ordersApi.setAllocations(props.orderId, {
      allocationMode: choice.allocationMode,
      allocations: [...choice.allocations],
      expectedRowVersion: props.rowVersion,
    });
    open.value = false;
    showToast({ message: t('orders.allocation.saved') });
    void summary.load(props.orderId, 'CURRENT');
    emit('changed');
  } catch (caught) {
    if (!change.absorbConflict(caught)) {
      const described = describeOrderError(caught);
      showToast({ message: t(described.key, described.params ?? {}) });
      if (described.reload) {
        open.value = false;
        emit('changed');
      }
    }
  } finally {
    busy.value = false;
  }
}

const onUpdate = (value: boolean): void => {
  if (!value && busy.value) return;
  open.value = value;
};
</script>

<template>
  <section class="holds" data-testid="order-allocation-panel">
    <p v-if="summary.state.value === 'loading'" class="holds__text" role="status">
      {{ t('state.loading') }}
    </p>
    <p
      v-else-if="summary.state.value === 'error'"
      class="holds__text holds__text--bad"
      role="alert"
    >
      {{ t('orders.allocation.loadError') }}
    </p>
    <template v-else-if="preview">
      <p v-if="preview.notAllocated" class="holds__text" data-testid="not-allocated">
        {{ t('orders.allocation.notAllocated') }}
      </p>
      <p
        v-else-if="preview.attention"
        class="holds__text holds__text--warn"
        role="status"
        data-testid="allocation-attention"
      >
        {{ t('orders.allocation.attention') }}
      </p>
      <p v-else class="holds__text">{{ t('orders.allocation.held') }}</p>
      <AppButton variant="secondary" size="xs" data-testid="allocation-change" @click="startChange">
        {{ t('orders.allocation.change') }}
      </AppButton>
    </template>

    <AppModal
      :model-value="open"
      :title="t('orders.allocation.changeTitle')"
      @update:model-value="onUpdate"
    >
      <AllocationPlanPicker :plan="change" :order-id="orderId" :disabled="busy" />
      <template #footer>
        <AppButton variant="secondary" size="lg" :disabled="busy" @click="onUpdate(false)">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton
          size="lg"
          :loading="busy"
          :disabled="!change.canSubmit.value"
          data-testid="allocation-save"
          @click="save"
        >
          {{ t('orders.allocation.save') }}
        </AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.holds {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 10px 14px;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.holds__text {
  flex: 1 1 200px;
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.holds__text--warn {
  font-weight: 600;
  color: var(--ink);
}

.holds__text--bad {
  color: var(--red);
}
</style>
