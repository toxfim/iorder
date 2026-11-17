<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';

// Every figure derived from the order list (counts, sums, debts) is a lower bound when the list was
// cut at the page limit. One component so no screen that shows such a figure forgets to say so.
const { t } = useI18n();
const { ordersStore } = useServices();
</script>

<template>
  <p v-if="ordersStore.truncated.value" class="cut" role="status">
    {{ t('orders.page.truncated') }}
  </p>
</template>

<style scoped>
.cut {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-input);
  background: var(--beige);
  font-size: var(--fs-small);
}
</style>
