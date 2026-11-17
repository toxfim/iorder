<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AppButton from '@core/components/ui/AppButton.vue';
import { showToast } from '@core/composables/use-toast';
import CustomerSheet from '@/features/customer-app/components/CustomerSheet.vue';
import { useCustomerServices } from '@/features/customer-app/services';
import GoodsIcon from './GoodsIcon.vue';
import '../goods.css';
const { t } = useI18n();
const router = useRouter();
const { goods, session } = useCustomerServices();
const open = ref(false),
  busy = ref(false);
const dismissed = new Set<string>();
const identity = computed(
  () => `${session.me.value?.userId ?? ''}:${session.me.value?.membership?.organizationId ?? ''}`,
);
watch(
  [identity, () => goods.summary.value?.discoveryPending, () => session.state.value],
  () => {
    open.value =
      session.state.value === 'ready' &&
      goods.summary.value?.discoveryPending === true &&
      !dismissed.has(identity.value);
  },
  { immediate: true },
);
async function dismiss(visit = false): Promise<void> {
  if (busy.value) return;
  dismissed.add(identity.value);
  open.value = false;
  busy.value = true;
  try {
    await goods.acknowledge();
  } catch {
    showToast({ message: t('customer.goods.discoveryAckFailed') });
  } finally {
    busy.value = false;
  }
  if (visit) await router.push({ name: 'customer-goods' });
}
</script>
<template>
  <CustomerSheet
    :model-value="open"
    :title="t('customer.goods.discoveryTitle')"
    @update:model-value="
      (value) => {
        if (!value) void dismiss();
      }
    "
    ><div class="goods-discovery">
      <GoodsIcon name="box" />
      <p>{{ t('customer.goods.discoveryHint') }}</p>
      <AppButton block :loading="busy" @click="dismiss(true)">{{
        t('customer.goods.discover')
      }}</AppButton
      ><AppButton block variant="ghost" @click="dismiss()">{{
        t('customer.goods.later')
      }}</AppButton>
    </div></CustomerSheet
  >
</template>
