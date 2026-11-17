<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import CustomerLogin from './CustomerLogin.vue';
import StateView from '@core/components/ui/StateView.vue';
import { readInitData, readLaunchFirstName } from '@core/telegram/launch';
import { useCustomerServices } from '../services';

// The screens before the app opens: not started from Telegram, no access, the profile request is
// running or failed. `denied` is the same screen for every cause on purpose (see the session).
const { t } = useI18n();
const { session } = useCustomerServices();

const state = session.state;
// Shown only while `/me` is loading; unverified, so it is a greeting and nothing more.
const firstName = computed(() => readLaunchFirstName(readInitData()));
</script>

<template>
  <section v-if="state === 'loading'" class="boot" role="status" aria-busy="true">
    <p v-if="firstName" class="boot__name">
      {{ t('customer.entry.greeting', { name: firstName }) }}
    </p>
    <p class="boot__text">{{ t('customer.entry.signingIn') }}</p>
  </section>

  <CustomerLogin v-else-if="state === 'no-telegram'" />

  <StateView
    v-else-if="state === 'denied'"
    state="denied"
    :title="t('customer.entry.denied.title')"
    :description="t('customer.entry.denied.description')"
  />

  <StateView v-else-if="state === 'error'" state="error" @retry="session.load()" />
</template>

<style scoped>
.boot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin: 64px auto;
  text-align: center;
}

.boot__name {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.boot__text {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t3);
}

.link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  border-radius: var(--r-btn-sm);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  font-size: var(--fs-body);
  font-weight: 600;
}
</style>
