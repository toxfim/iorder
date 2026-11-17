<script setup lang="ts">
import PersonName from '@/features/people/components/PersonName.vue';
import { useI18n } from 'vue-i18n';
import type { DeliveryContact } from '@iorder/shared/staff-orders';
import { formatPhone, telHref } from '@core/lib/phone';
import StaffIcon from '@/components/ui/StaffIcon.vue';

defineProps<{ contact: DeliveryContact }>();

const { t } = useI18n();
</script>

<template>
  <section class="contact" :aria-label="t('orders.contact.title')">
    <h2 class="contact__title">{{ t('orders.contact.title') }}</h2>
    <b class="contact__org">{{ contact.organizationName }}</b>
    <p v-if="contact.contacts.length === 0" class="contact__empty">
      {{ t('orders.contact.none') }}
    </p>
    <ul v-else class="contact__list">
      <li v-for="(person, index) in contact.contacts" :key="index" class="person">
        <span class="person__main">
          <span class="person__name"
            ><PersonName :name="person.fullName" :user-id="person.userId"
          /></span>
          <span class="person__roles">
            <template v-if="person.placedTheOrder">{{ t('orders.contact.placed') }}</template>
            <template v-if="person.placedTheOrder && person.isShopOwner"> · </template>
            <template v-if="person.isShopOwner">{{ t('orders.contact.owner') }}</template>
          </span>
        </span>
        <a
          v-if="person.phone"
          class="person__call"
          :href="telHref(person.phone)"
          :aria-label="t('orders.contact.callLabel', { name: person.fullName })"
        >
          <StaffIcon name="phone" :size="13" />
          {{ formatPhone(person.phone) }}
        </a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* v8 "Yetkazish kontakti": a white hairline card, people ruled by hairlines, the phone as an
   orange link on the right. */
.contact {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.contact__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.contact__org {
  font-size: var(--fs-small);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.contact__empty {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.contact__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.person {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 12px 0;
  border-top: 1px solid var(--e8);
}

.person:last-child {
  padding-bottom: 0;
}

.person__main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.person__name {
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}

.person__roles {
  font-size: var(--fs-group);
  color: var(--t2);
}

.person__call {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--acc-fg);
  text-decoration: none;
}

.person__call:hover {
  text-decoration: underline;
}

/* Drivers and warehouse staff call from a phone: a thumb-sized target. */
@media (pointer: coarse), (hover: none) {
  .person__call {
    min-height: 44px;
  }
}
</style>
