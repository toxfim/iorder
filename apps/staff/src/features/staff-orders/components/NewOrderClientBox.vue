<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import { formatPhone } from '@core/lib/phone';
import OrganizationTags from './OrganizationTags.vue';

// The design's «MIJOZ» box of the new order: the customer, who the order is placed by, the tags,
// and "O'zgartirish" back to step 1 (the cart is kept). `plain` draws it without the grey box.
const props = defineProps<{
  customer: NewOrderCustomer;
  member: NewOrderCustomerMember;
  changeable?: boolean;
  plain?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();
const { t } = useI18n();

const line = computed(() =>
  [props.member.fullName, props.member.phone ? formatPhone(props.member.phone) : null]
    .filter(Boolean)
    .join(' · '),
);
</script>

<template>
  <section
    class="cbox"
    :class="{ 'cbox--plain': plain }"
    :aria-label="t('orders.newOrder.client')"
    data-testid="new-order-client"
  >
    <span class="lbl">{{ t('orders.newOrder.client') }}</span>
    <b class="cbox__name">{{ customer.name }}</b>
    <span class="cbox__line">{{ line }}</span>
    <div class="cbox__foot">
      <OrganizationTags :type="customer.type" :label="customer.label" />
      <button
        v-if="changeable"
        type="button"
        class="cbox__change"
        data-testid="new-order-change-customer"
        @click="emit('change')"
      >
        {{ t('orders.newOrder.items.change') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.cbox {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 12px 12px;
  border-radius: 12px;
  background: var(--f5);
}

.cbox--plain {
  padding: 0;
  background: transparent;
}

.lbl {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t3);
}

.cbox__name {
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.cbox__line {
  font-size: var(--fs-body);
  color: var(--t2);
}

.cbox--plain .cbox__line {
  font-size: var(--fs-section);
}

.cbox__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}

.cbox__change {
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--e8);
  border-radius: 9px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  cursor: pointer;
}

.cbox__change:hover {
  background: var(--hov);
}

.cbox__change:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

@media (pointer: coarse), (hover: none) {
  .cbox__change {
    min-height: 44px;
  }
}
</style>
