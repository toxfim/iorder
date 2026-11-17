<script setup lang="ts">
import type { CustomerUnitCode } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { showToast } from '@core/composables/use-toast';
import GoodsIcon from './GoodsIcon.vue';
defineProps<{ codes: readonly CustomerUnitCode[] }>();
const { t } = useI18n();
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showToast({ message: t('customer.goods.copied') });
  } catch {
    showToast({ message: t('customer.goods.copyFailed') });
  }
}
</script>
<template>
  <div class="goods-codes">
    <p v-if="codes.length === 0" class="goods-muted">{{ t('customer.goods.noCodes') }}</p>
    <div v-for="code in codes" :key="`${code.kind}:${code.slot}`" class="goods-code">
      <span class="goods-muted"
        >{{ t(`customer.goods.kinds.${code.kind}`)
        }}<template v-if="codes.filter((c) => c.kind === code.kind).length > 1">
          {{ code.slot }}</template
        ></span
      ><code>{{ code.value }}</code
      ><button
        type="button"
        :aria-label="t('customer.goods.copy', { code: code.value })"
        @click="copy(code.value)"
      >
        <GoodsIcon name="copy" />
      </button>
    </div>
  </div>
</template>
