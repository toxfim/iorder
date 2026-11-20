<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { OrderStatus } from '@iorder/shared';
import { stageTone } from '../domain/order-presentation';

// The status pill of the approved «Buyurtmalar» design: a soft fill with dark text of the same
// tone, always with the word (never colour alone). The real status, the staff name of its stage.
defineProps<{ status: OrderStatus }>();
const { t } = useI18n();
</script>

<template>
  <span class="pill" :class="`pill--${stageTone(status)}`">{{ t(`orders.stages.${status}`) }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-meta);
  font-weight: 500;
  white-space: nowrap;
}

.pill--accent {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.pill--info {
  background: var(--blue-bg);
  color: var(--blue);
}

.pill--success {
  background: var(--green-bg);
  color: var(--green);
}

.pill--danger {
  background: var(--red-bg);
  color: var(--red);
}

.pill--neutral {
  background: var(--ef);
  color: var(--t2);
}
</style>
