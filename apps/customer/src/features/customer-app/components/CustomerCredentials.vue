<script setup lang="ts">
import { defineAsyncComponent, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { customerCredentialsRequestSchema } from '@iorder/shared';
import AppButton from '@core/components/ui/AppButton.vue';
import GoodsIcon from '@/features/customer-goods/components/GoodsIcon.vue';
import { useCustomerServices } from '../services';
import { readInitData } from '@core/telegram/launch';
import { TELEGRAM_BOT_USERNAME } from '@core/app/env';
const TelegramLoginWidget = defineAsyncComponent(
  () => import('@core/telegram/components/TelegramLoginWidget.vue'),
);
// The schema's own minimum: the browser refuses a shorter value before the schema sees it.
const PASSWORD_MIN_LENGTH = 8;
const canEdit = ref(false);
const { t } = useI18n();
const { auth, session, cart } = useCustomerServices();
const id = useId();
const login = ref('');
const password = ref('');
const repeat = ref('');
const busy = ref(false);
const loading = ref(false);
const open = ref(false);
const loaded = ref(false);
const message = ref<'saved' | 'invalid' | 'saveFailed' | 'loadFailed' | null>(null);
async function load(): Promise<void> {
  loading.value = true;
  message.value = null;
  try {
    if (auth) {
      const answer = await auth.credentials();
      login.value = answer.login ?? '';
      canEdit.value = answer.canEdit === true;
    }
    loaded.value = true;
  } catch {
    message.value = 'loadFailed';
  } finally {
    loading.value = false;
  }
}
// Read on the first opening: most profile visits never open this, and neither the request nor the
// Telegram widget should cost them anything. Closing forgets typed passwords.
function toggle(): void {
  open.value = !open.value;
  if (open.value) {
    if (!loaded.value) void load();
    return;
  }
  password.value = '';
  repeat.value = '';
  if (loaded.value) message.value = null;
}
function signInAgain(): void {
  cart.clear();
  session.signedOut();
}
async function telegram(payload: Readonly<Record<string, unknown>>): Promise<void> {
  if (!auth || busy.value) return;
  busy.value = true;
  try {
    await auth.telegram(payload);
    window.location.reload();
  } catch {
    message.value = 'saveFailed';
  } finally {
    busy.value = false;
  }
}
async function save(): Promise<void> {
  if (!auth || busy.value) return;
  const input = customerCredentialsRequestSchema.safeParse({
    login: login.value.trim().toLowerCase(),
    password: password.value,
  });
  if (!input.success || password.value !== repeat.value) {
    message.value = 'invalid';
    return;
  }
  busy.value = true;
  password.value = '';
  repeat.value = '';
  try {
    await auth.setCredentials(input.data);
    message.value = 'saved';
  } catch {
    message.value = 'saveFailed';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="auth" class="credentials" :class="{ 'credentials--open': open }">
    <button
      type="button"
      class="credentials__toggle"
      :aria-expanded="open"
      :aria-controls="`${id}-body`"
      data-testid="credentials-toggle"
      @click="toggle"
    >
      <strong class="credentials__title">{{ t('customer.auth.credentials') }}</strong>
      <GoodsIcon class="credentials__chevron" name="right" />
    </button>
    <div v-if="open" :id="`${id}-body`" class="credentials__body">
      <p class="credentials__note">{{ t('customer.auth.credentialsHint') }}</p>
      <p v-if="loading" class="credentials__note" role="status">
        {{ t('customer.auth.loading') }}
      </p>
      <form
        v-else-if="canEdit && message !== 'loadFailed' && message !== 'saved'"
        class="credentials__form"
        @submit.prevent="save"
      >
        <label class="credentials__field" :for="`${id}-login`">
          {{ t('customer.auth.login') }}
          <input
            :id="`${id}-login`"
            v-model="login"
            autocomplete="username"
            autocapitalize="none"
            :spellcheck="false"
            maxlength="64"
            required
            :disabled="busy"
          />
        </label>
        <label class="credentials__field" :for="`${id}-password`">
          {{ t('customer.auth.newPassword') }}
          <input
            :id="`${id}-password`"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :minlength="PASSWORD_MIN_LENGTH"
            maxlength="128"
            required
            :disabled="busy"
          />
        </label>
        <label class="credentials__field" :for="`${id}-repeat`">
          {{ t('customer.auth.repeatPassword') }}
          <input
            :id="`${id}-repeat`"
            v-model="repeat"
            type="password"
            autocomplete="new-password"
            :minlength="PASSWORD_MIN_LENGTH"
            maxlength="128"
            required
            :disabled="busy"
          />
        </label>
        <p v-if="message" class="credentials__message" role="alert">
          {{ t(`customer.auth.${message}`) }}
        </p>
        <AppButton type="submit" :loading="busy" :disabled="busy">{{
          t('customer.auth.save')
        }}</AppButton>
      </form>
      <div
        v-if="!loading && !canEdit && message !== 'loadFailed'"
        class="credentials__telegram"
        :inert="busy"
      >
        <p class="credentials__note">{{ t('customer.auth.telegramRequired') }}</p>
        <TelegramLoginWidget
          v-if="TELEGRAM_BOT_USERNAME"
          :bot-username="TELEGRAM_BOT_USERNAME"
          @auth="telegram"
        />
        <p v-else class="credentials__note">{{ t('customer.auth.telegramUnavailable') }}</p>
      </div>
      <p
        v-if="message && !(canEdit && message !== 'loadFailed' && message !== 'saved')"
        class="credentials__message"
        :class="{ 'credentials__message--ok': message === 'saved' }"
        role="status"
      >
        {{ t(`customer.auth.${message}`) }}
      </p>
      <AppButton v-if="message === 'loadFailed'" @click="load">{{
        t('customer.auth.retry')
      }}</AppButton>
      <AppButton v-if="message === 'saved' && !readInitData()" @click="signInAgain">{{
        t('customer.auth.signIn')
      }}</AppButton>
    </div>
  </section>
</template>
<style scoped>
.credentials {
  border-radius: var(--r-row);
  background: var(--w);
}
.credentials__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 16px;
  border: 0;
  border-radius: var(--r-row);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.credentials__title {
  font-size: var(--fs-body);
  font-weight: 600;
}
.credentials__chevron {
  flex: none;
  transition: transform 0.16s var(--ease);
}
.credentials--open .credentials__chevron {
  transform: rotate(90deg);
}
.credentials__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 480px;
  padding: 0 16px 16px;
}
.credentials__form,
.credentials__telegram {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.credentials__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--t2);
  font-size: var(--fs-meta);
}
/* 16px: a smaller input makes iOS zoom the whole page on focus. */
.credentials__field input {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--d9);
  border-radius: var(--r-input);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: 16px;
}
.credentials__field input:focus-visible {
  border-color: var(--acc);
  outline: 2px solid var(--acc-bg);
}
.credentials__field input:disabled {
  background: var(--ef);
  color: var(--t3);
}
.credentials__note {
  margin: 0;
  color: var(--t3);
  font-size: var(--fs-meta);
  line-height: 1.5;
}
.credentials__message {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-meta);
}
.credentials__message--ok {
  background: var(--green-bg);
  color: var(--green);
}
@media (prefers-reduced-motion: reduce) {
  .credentials__chevron {
    transition: none;
  }
}
</style>
