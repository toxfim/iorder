<script setup lang="ts">
import { useFormat } from '@core/i18n/use-format';

// The ONE place the home page prints a price or an amount. It only calls the app's money
// formatter, so a change of the shown currency touches this file alone.
defineProps<{ amount: string }>();
const { formatMoneyWithCurrency } = useFormat();
</script>

<template>
  <span class="price">{{ formatMoneyWithCurrency(amount) }}</span>
</template>

<style scoped>
.price {
  font-variant-numeric: tabular-nums;
}
</style>
