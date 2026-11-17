<script setup lang="ts">
import type { SetOwnContactRequest } from '@iorder/shared';
import GoodsIcon from '@/features/customer-goods/components/GoodsIcon.vue';
import '@/features/customer-goods/goods.css';
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { showToast } from '@core/composables/use-toast';
import { LOCALE_NAMES } from '@core/i18n';
import { useLocale } from '@core/i18n/use-locale';
import { formatPhone } from '@core/lib/phone';
import { suppressAutomaticHandoff } from '@/features/customer-session/site-handoff';
import { useCustomerServices } from '../services';
import AmountToPayCard from '@/features/customer-balance/components/AmountToPayCard.vue';
import ContactDialog from '@/features/customer-session/components/ContactDialog.vue';
import {
  useContactFailure,
  type ContactFailure,
} from '@/features/customer-session/composables/contact-failure';
import CustomerCredentials from './CustomerCredentials.vue';
import CustomerSheet from './CustomerSheet.vue';

const { t } = useI18n();
const { session, auth, cart } = useCustomerServices();
const { locale, locales, setLocale } = useLocale();
const languageOpen = ref(false);
async function logout(): Promise<void> {
  if (auth) {
    // A sign-out made here on purpose must not be undone by the next tab that continues with the
    // company site's sign-in by itself.
    suppressAutomaticHandoff();
    try {
      await auth.logout();
    } finally {
      cart.clear();
      session.signedOut();
    }
  }
}
const me = computed(() => session.me.value);
const viewer = computed(() => session.staffViewer.value);
const initials = computed(() =>
  (me.value?.fullName ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join(''),
);

// A customer changes their own name and phone here, as often as needed [C, 2026-11-09]. A company
// employee viewing the app does it in the staff app, so for them the section is read-only.
const editOpen = ref(false);
const saving = ref(false);
const failure = shallowRef<ContactFailure | null>(null);
const describeFailure = useContactFailure();

function openEdit(): void {
  failure.value = null;
  editOpen.value = true;
}

async function saveProfile(request: SetOwnContactRequest): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  failure.value = null;
  try {
    await session.setContact(request);
  } catch (caught) {
    failure.value = describeFailure(caught);
    return;
  } finally {
    saving.value = false;
  }
  editOpen.value = false;
  showToast({ message: t('customer.profileEdit.saved') });
}
</script>

<template>
  <section class="profile">
    <h1>{{ t('customer.presentation.profile') }}</h1>
    <div class="identity">
      <div class="avatar">{{ initials }}</div>
      <div>
        <h2>{{ me?.fullName }}</h2>
        <p>{{ t('customer.presentation.telegramLogin') }}</p>
      </div>
    </div>
    <button
      class="language"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="languageOpen"
      @click="languageOpen = true"
    >
      <span>{{ t('customer.presentation.appLanguage') }}</span
      ><span
        >{{ LOCALE_NAMES[locale] }} <span aria-hidden="true">{{ '›' }}</span></span
      >
    </button>
    <RouterLink class="goods-profile-entry" :to="{ name: 'customer-goods' }"
      ><GoodsIcon name="box" />
      <div>
        <strong>{{ t('customer.goods.title') }}</strong
        ><span>{{ t('customer.goods.profileHint') }}</span>
      </div>
      <GoodsIcon name="right"
    /></RouterLink>
    <div class="profile-sections">
      <div class="profile-contact">
        <section>
          <div class="section-head">
            <h3>{{ t('customer.presentation.personalDetails') }}</h3>
            <button
              v-if="!viewer"
              class="section-action"
              type="button"
              aria-haspopup="dialog"
              data-testid="profile-edit"
              @click="openEdit"
            >
              {{ t('customer.profileEdit.action') }}
            </button>
          </div>
          <dl class="details">
            <div>
              <dt>{{ t('customer.presentation.fullName') }}</dt>
              <dd data-testid="profile-name">{{ me?.fullName }}</dd>
            </div>
            <!-- An employee's phone is not part of what this app is told about them. -->
            <div v-if="!viewer">
              <dt>{{ t('customer.contact.phone') }}</dt>
              <dd data-testid="profile-phone">
                {{
                  me?.contact
                    ? formatPhone(me.contact.phone)
                    : t('customer.presentation.phoneMissing')
                }}
              </dd>
            </div>
          </dl>
        </section>
        <p class="hint" data-testid="profile-contact-hint">
          {{
            viewer ? t('customer.profileEdit.viewerHint') : t('customer.presentation.contactHint')
          }}
        </p>
      </div>
      <!-- A company employee viewing the app has no shop and no customer login of their own. -->
      <section v-if="viewer" data-testid="viewer-profile">
        <h3>{{ t('customer.viewer.label') }}</h3>
        <div class="organization">
          <h2>{{ session.organizationName.value ?? t('customer.viewer.noShop') }}</h2>
          <p>
            {{
              viewer.canOrder && viewer.organizationName !== null
                ? t('customer.viewer.noticeOrdering', { organization: viewer.organizationName })
                : t('customer.viewer.notice')
            }}
          </p>
        </div>
      </section>
      <section v-else>
        <h3>{{ t('customer.presentation.yourShop') }}</h3>
        <div class="organization">
          <h2>{{ me?.membership?.organizationName ?? t('customer.presentation.yourShop') }}</h2>
          <p>{{ t('customer.presentation.groupLinked') }}</p>
        </div>
      </section>
      <AmountToPayCard />
    </div>
    <CustomerCredentials v-if="!viewer" />
    <button v-if="auth" class="language" type="button" @click="logout">
      {{ t('customer.auth.logout') }}
    </button>
    <ContactDialog
      v-if="!viewer"
      v-model="editOpen"
      mode="edit"
      :initial-name="me?.fullName ?? ''"
      :initial-phone="me?.contact?.phone ?? null"
      :loading="saving"
      :failure="failure"
      @confirm="saveProfile"
    />
    <CustomerSheet v-model="languageOpen" :title="t('customer.presentation.appLanguage')">
      <div class="languages">
        <button
          v-for="value in locales"
          :key="value"
          type="button"
          :class="{ selected: locale === value }"
          :aria-pressed="locale === value"
          @click="
            setLocale(value);
            languageOpen = false;
          "
        >
          <span>{{ LOCALE_NAMES[value] }}</span
          ><span v-if="locale === value" aria-hidden="true">{{ '✓' }}</span>
        </button>
      </div>
    </CustomerSheet>
  </section>
</template>

<style scoped>
.profile {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.profile-sections,
.profile-contact {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
h1 {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}
h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
h3 {
  margin: 0 0 10px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--t3);
}
/* The heading and its action share one line; the heading keeps its usual distance to the card. */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.section-head h3 {
  margin: 0;
}
/* A 44px touch target that does not make the heading line taller: the negative margins give the
   height back, and the right one lines the label up with the card's edge. */
.section-action {
  flex: none;
  min-height: 44px;
  margin: -16px -8px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  cursor: pointer;
}
.section-action:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}
p {
  margin: 4px 0 0;
  color: var(--t3);
  font-size: var(--fs-meta);
}
.identity {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 18px;
  min-height: 106px;
  border-radius: var(--r-panel);
  background: var(--w);
}
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  color: var(--acc-fg);
  background: var(--acc-bg);
  font-size: 20px;
  font-weight: 600;
}
.language {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 16px;
  margin-bottom: 4px;
  border: 0;
  border-radius: var(--r-row);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  cursor: pointer;
  text-align: left;
}
.language > span:last-child {
  color: var(--acc-fg);
}
.details {
  margin: 0;
  padding: 16px;
  background: var(--w);
  border-radius: var(--r-row);
}
.details > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
}
dt {
  color: var(--t3);
  font-size: var(--fs-meta);
}
dd {
  margin: 0;
  font-size: var(--fs-body);
  text-align: right;
  overflow-wrap: anywhere;
}
.hint {
  margin: 0 0 16px;
  line-height: 1.5;
}
.organization {
  padding: 16px;
  background: var(--w);
  border-radius: var(--r-row);
}
.organization h2 {
  font-size: 17px;
}
.languages {
  display: grid;
  gap: 12px;
}
.languages button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  min-height: 48px;
  width: 100%;
  background: transparent;
  color: var(--ink);
  border: 0;
  border-radius: var(--r-btn-sm);
  font: inherit;
  cursor: pointer;
}
.languages .selected {
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-weight: 600;
}
</style>
