<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppDrawer from '@/components/ui/AppDrawer.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import PriceHistoryBody from './PriceHistoryBody.vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    productId: string | null;
    /** Shown as the sub-heading: product code in monospace and the localized name. */
    productCode: string;
    name: string;
    /**
     * The price history endpoint is for the people who change prices (the accountant gets 403),
     * so a read-only viewer sees only the sections passed in the slot.
     */
    showPriceHistory?: boolean;
  }>(),
  { showPriceHistory: true },
);
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
</script>

<template>
  <!-- "Tovar tarixi" drawer: right side, min(600px,100%); AppDrawer owns the two-step close.
       The body follows the design's right-hand panel: the product, the price rule, then cards. -->
  <AppDrawer
    :model-value="modelValue"
    :title="t('prices.history.title')"
    width="min(600px, 100%)"
    @update:model-value="(open) => emit('update:modelValue', open)"
  >
    <div class="panel">
      <div class="product">
        <span class="product__name">{{ name }}</span>
        <span class="mono product__code">{{ productCode }}</span>
      </div>
      <template v-if="productId && showPriceHistory">
        <!-- Hard rule 4: orders keep the price they were placed with. -->
        <p class="rule" role="note">
          <StaffIcon name="lock" :size="15" class="rule__icon" />
          <span>{{ t('prices.history.ruleNote') }}</span>
        </p>
        <PriceHistoryBody :key="productId" :product-id="productId" />
      </template>
      <!-- Sections that only some roles may see (the supply history) come at the END. -->
      <slot />
    </div>
  </AppDrawer>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.product {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.product__name {
  font-size: var(--fs-section);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.product__code {
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* The design's accent notice ("Yangi narx faqat keyingi buyurtmalarga qo'llanadi"). */
.rule {
  display: flex;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
}

.rule__icon {
  flex: none;
  margin-top: 1px;
}
</style>
