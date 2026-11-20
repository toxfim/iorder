<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { OrganizationLabel, OrganizationType } from '@iorder/shared';
import type { DeliveryContact } from '@iorder/shared/staff-orders';
import PersonName from '@/features/people/components/PersonName.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { formatPhone, telHref } from '@core/lib/phone';
import OrganizationTags from './OrganizationTags.vue';

// The order page's «Mijoz» card (approved design): the organization, then who to call. The people
// come from the server's delivery contact (the person who placed the order and the shop owner);
// the accountant gets none (`contact` null), and the card says why. The label comes only with the
// FULL view (null for the warehouse and the driver).
defineProps<{
  organizationName: string;
  organizationType: OrganizationType;
  organizationLabel: OrganizationLabel | null;
  contact: DeliveryContact | null;
}>();

const { t } = useI18n();
</script>

<template>
  <section class="client" :aria-label="t('orders.view.client')">
    <span class="lbl">{{ t('orders.view.client') }}</span>
    <b class="client__name">{{ organizationName }}</b>
    <OrganizationTags :type="organizationType" :label="organizationLabel" />
    <div class="client__people">
      <template v-if="contact">
        <p v-if="contact.contacts.length === 0" class="muted">{{ t('orders.contact.none') }}</p>
        <div
          v-for="(person, index) in contact.contacts"
          :key="person.userId"
          class="person"
          data-testid="client-person"
        >
          <span v-if="index === 0" class="person__k">{{ t('orders.view.contact') }}</span>
          <b class="person__name"
            ><PersonName :name="person.fullName" :user-id="person.userId"
          /></b>
          <span class="person__roles">
            <template v-if="person.placedTheOrder">{{ t('orders.contact.placed') }}</template>
            <template v-if="person.placedTheOrder && person.isShopOwner"> · </template>
            <template v-if="person.isShopOwner">{{ t('orders.contact.owner') }}</template>
          </span>
          <template v-if="person.phone">
            <a
              class="person__phone"
              :href="telHref(person.phone)"
              :aria-label="t('orders.contact.callLabel', { name: person.fullName })"
              >{{ formatPhone(person.phone) }}</a
            >
            <!-- Tablet and phone: a thumb-sized call button under the number (the design). -->
            <a
              class="person__call"
              :href="telHref(person.phone)"
              :aria-label="t('orders.contact.callLabel', { name: person.fullName })"
            >
              <StaffIcon name="phone" :size="18" />
              {{ t('orders.view.call') }}
            </a>
          </template>
        </div>
      </template>
      <p v-else class="muted">{{ t('orders.contact.hiddenForRole') }}</p>
    </div>
  </section>
</template>

<style scoped>
.client {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--e8);
  border-radius: 14px;
  background: var(--w);
}

.lbl {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t3);
}

.client__name {
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.client__people {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ef);
}

.person {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.person + .person {
  padding-top: 12px;
  border-top: 1px solid var(--ef);
}

.person__k,
.person__roles {
  font-size: var(--fs-small);
  color: var(--t3);
}

.person__name {
  font-size: var(--fs-section);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.person__phone {
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: var(--fs-body);
  color: var(--ink);
  text-decoration: none;
  white-space: nowrap;
}

.person__phone:hover {
  color: var(--acc-fg);
}

.person__call {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 48px;
  margin-top: 10px;
  border: 1px solid var(--acc);
  border-radius: 10px;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-section);
  font-weight: 600;
  text-decoration: none;
}

.muted {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

@media (max-width: 1023px) {
  .person__call {
    display: inline-flex;
  }
}

@media (pointer: coarse), (hover: none) {
  .person__phone {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
}
</style>
