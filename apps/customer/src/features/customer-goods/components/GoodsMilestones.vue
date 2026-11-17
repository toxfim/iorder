<script setup lang="ts">
import type { CustomerMilestones } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import GoodsIcon from './GoodsIcon.vue';
defineProps<{ milestones: CustomerMilestones }>();
const { t } = useI18n();
const { formatDateTime } = useFormat();
// The api also sends `confirmedAt` (the manager's approval). It is a step inside the company, and
// a customer sees none of those (owner rule 2026-11-09), so it has no row here.
const stages = ['orderedAt', 'deliveredAt'] as const;
</script>
<template>
  <ol class="goods-milestones">
    <li v-for="key in stages" :key="key" :class="{ pending: !milestones[key] }">
      <span class="milestone-mark"
        ><GoodsIcon :name="milestones[key] ? 'check' : 'pending'"
      /></span>
      <div>
        <p>{{ t(`customer.goods.milestones.${key}`) }}</p>
        <time v-if="milestones[key]" :datetime="milestones[key] ?? undefined">{{
          formatDateTime(milestones[key])
        }}</time
        ><span v-else class="goods-muted">{{ t(`customer.goods.pending.${key}`) }}</span>
      </div>
    </li>
  </ol>
</template>
