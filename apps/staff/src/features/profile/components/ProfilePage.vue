<script setup lang="ts">
import { LOCALES } from '@iorder/shared';
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppCard from '@/components/ui/AppCard.vue';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { initialsOf } from '@/features/directory/domain/directory-model';
import { useTheme } from '@/features/preferences/composables/use-theme';
import { THEME_CHOICES, isThemeChoice } from '@/features/preferences/theme';
import type { OwnProfile } from '@/features/staff-profile/api/own-profile-api';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { LOCALE_NAMES, isLocale } from '@core/i18n';
import { useLocale } from '@core/i18n/use-locale';
import { formatPhone } from '@core/lib/phone';
import OwnProfileDialog from './OwnProfileDialog.vue';
import StaffBotConnection from './StaffBotConnection.vue';

// Design v8 "My profile", built only on what the app really has: the signed-in person's name and
// roles (from the session), their own name and phone, which they change here ([C] 2026-11-09),
// their own bot connection, and the language and theme preferences (kept in this browser). The
// api has no self-service password route, no session list and no two-step sign-in, so the
// design's "change password", 2FA and active sessions are shown as read-only facts or left out;
// nothing pretends to save.

const { t } = useI18n();
const { currentUser, ownProfileApi } = useServices();
const { locale, setLocale } = useLocale();
const { choice, setChoice } = useTheme();

const user = computed(() => currentUser.user.value);
const initials = computed(() => initialsOf(user.value?.displayName ?? ''));
const roleNames = computed(() =>
  (user.value?.staffRoles ?? []).map((role) => t(`roles.staff.${role}`)).join(', '),
);

const localeOptions = computed(() =>
  LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
);
const THEME_LABELS = {
  system: 'common.themeSystem',
  light: 'common.themeLight',
  dark: 'common.themeDark',
} as const;
const themeOptions = computed(() =>
  THEME_CHOICES.map((value) => ({ value, label: t(THEME_LABELS[value]) })),
);

// The session carries the name only; the phone comes from the person's own profile. Until it is
// read the edit action stays off: saving replaces both fields, and an unread phone would be lost.
const profile = shallowRef<OwnProfile | null>(null);
const profileState = ref<'loading' | 'ready' | 'error'>('loading');
const editOpen = ref(false);
let profileRun = 0;

function adopt(own: OwnProfile): void {
  profile.value = own;
  profileState.value = 'ready';
  // The sidebar and the top bar show the session's name: keep it the one just read or saved.
  if (own.fullName !== user.value?.displayName) currentUser.setDisplayName(own.fullName);
}

async function loadProfile(): Promise<void> {
  const mine = ++profileRun;
  profileState.value = 'loading';
  try {
    const own = await ownProfileApi.get();
    if (mine === profileRun) adopt(own);
  } catch (caught) {
    console.error(caught);
    if (mine === profileRun) profileState.value = 'error';
  }
}

onMounted(() => void loadProfile());

function onLocale(value: string): void {
  if (isLocale(value)) setLocale(value);
}
function onTheme(value: string): void {
  if (isThemeChoice(value)) setChoice(value);
}
</script>

<template>
  <div class="page">
    <header class="head">
      <h1 class="head__title">{{ t('staffProfile.title') }}</h1>
      <p class="head__info">{{ t('staffProfile.subtitle') }}</p>
    </header>

    <!-- The route guard already needs a signed-in staff member; this covers a session that ends
         while the page is open. -->
    <StateView v-if="!user" state="denied" />
    <div v-else class="grid">
      <div class="col">
        <section class="identity" data-testid="profile-identity">
          <span class="identity__avatar" aria-hidden="true">{{ initials }}</span>
          <h2 class="identity__name">{{ user.displayName }}</h2>
          <ul class="identity__roles">
            <li v-for="role in user.staffRoles" :key="role">
              <AppBadge tone="accent" dot>{{ t(`roles.staff.${role}`) }}</AppBadge>
            </li>
          </ul>
          <div class="identity__facts">
            <span class="fact__label">{{ t('staffProfile.workspace') }}</span>
            <span class="fact__value">{{ t('nav.workspaceCard.title') }}</span>
          </div>
        </section>

        <StaffBotConnection
          :title="t('staffProfile.bot.title')"
          :subtitle="t('staffProfile.bot.subtitle')"
        />
      </div>

      <div class="col">
        <AppCard
          class="personal"
          :title="t('staffProfile.personal.title')"
          :subtitle="t('staffProfile.personal.subtitle')"
        >
          <template #actions>
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="profile === null"
              aria-haspopup="dialog"
              data-testid="profile-edit"
              @click="editOpen = true"
            >
              {{ t('staffProfile.personal.edit') }}
            </AppButton>
          </template>
          <div class="body">
            <div class="fields">
              <div class="field">
                <span class="field__label">{{ t('staffProfile.personal.name') }}</span>
                <span class="field__static" data-testid="profile-name">{{ user.displayName }}</span>
              </div>
              <div class="field">
                <span class="field__label">{{ t('staffProfile.personal.phone') }}</span>
                <span
                  class="field__static"
                  :class="{ 'field__static--quiet': !profile?.phone }"
                  :data-state="profileState"
                  data-testid="profile-phone"
                >
                  <template v-if="profileState === 'loading'">
                    {{ t('staffProfile.personal.phoneLoading') }}
                  </template>
                  <template v-else-if="profileState === 'error'">
                    <span role="alert">{{ t('staffProfile.personal.phoneError') }}</span>
                    <button
                      type="button"
                      class="field__retry"
                      data-testid="profile-retry"
                      @click="loadProfile"
                    >
                      {{ t('staffProfile.personal.retry') }}
                    </button>
                  </template>
                  <template v-else>
                    {{
                      profile?.phone
                        ? formatPhone(profile.phone)
                        : t('staffProfile.personal.phoneMissing')
                    }}
                  </template>
                </span>
              </div>
              <div class="field">
                <span class="field__label">{{ t('staffProfile.personal.language') }}</span>
                <AppDropdown
                  :model-value="locale"
                  :options="localeOptions"
                  :label="t('staffProfile.personal.language')"
                  min-width="100%"
                  @update:model-value="onLocale"
                />
              </div>
              <div class="field">
                <span class="field__label">{{ t('staffProfile.personal.theme') }}</span>
                <AppDropdown
                  :model-value="choice"
                  :options="themeOptions"
                  :label="t('staffProfile.personal.theme')"
                  min-width="100%"
                  @update:model-value="onTheme"
                />
              </div>
              <div class="field">
                <span class="field__label">{{ t('staffProfile.personal.timezone') }}</span>
                <span class="field__static">{{ t('staffProfile.personal.timezoneValue') }}</span>
              </div>
            </div>

            <div class="role" data-testid="profile-role">
              <StaffIcon name="shieldcheck" :size="17" class="role__icon" />
              <div class="role__text">
                <span class="role__title">
                  {{ t('staffProfile.role.title', { roles: roleNames }) }}
                </span>
                <span v-for="role in user.staffRoles" :key="role" class="role__body">
                  {{ t(`staffProfile.role.describe.${role}`) }}
                </span>
                <span class="role__body">{{ t('staffProfile.role.change') }}</span>
              </div>
            </div>
          </div>
        </AppCard>

        <AppCard
          :title="t('staffProfile.security.title')"
          :subtitle="t('staffProfile.security.subtitle')"
        >
          <div class="body">
            <div class="security">
              <StaffIcon name="key" :size="16" class="security__icon" />
              <div class="security__text">
                <span class="security__title">{{ t('staffProfile.security.password') }}</span>
                <span class="security__hint" data-testid="profile-password-hint">
                  {{ t('staffProfile.security.passwordHint') }}
                </span>
              </div>
            </div>
          </div>
        </AppCard>
      </div>
    </div>

    <OwnProfileDialog v-if="profile" v-model="editOpen" :profile="profile" @saved="adopt" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* v8 page title, the same on every staff page: 28px regular. */
.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__info {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

/* v8: a 330px column (identity, notifications) beside the wide column (details, security). */
.grid {
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.identity {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.identity__avatar {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: 19px;
  font-weight: 600;
}

.identity__name {
  margin: 6px 0 0;
  font-size: 19px;
  font-weight: 600;
  text-align: center;
}

.identity__roles {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.identity__facts {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  gap: 2px;
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.fact__label {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fact__value {
  font-size: var(--fs-small);
}

/* The kit's card header lets its actions wrap under a long heading. Here the edit action stays on
   the heading's line at every width (a phone inside Telegram too): the heading takes the space
   that is left and wraps its own text instead. */
.personal :deep(.card__head) {
  flex-wrap: nowrap;
}

.personal :deep(.card__heading) {
  flex: 1 1 0;
}

.personal :deep(.card__actions) {
  flex: none;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0 20px 20px;
}

.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field__label {
  font-size: var(--fs-meta);
  font-weight: 500;
}

/* A read-only value in the shape of the v8 input, on the grey input fill so it does not look
   editable. */
.field__static {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--f5);
  font-size: var(--fs-small);
  overflow-wrap: anywhere;
}

/* "Not entered", "loading" and "could not be read" are states, not a value. */
.field__static--quiet {
  color: var(--t2);
}

/* The retry sits at the right end of the same line as the sentence it belongs to. */
.field__retry {
  min-height: 40px;
  margin-left: auto;
  padding: 0 4px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.field__retry:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

@media (pointer: coarse), (hover: none) {
  .field__retry {
    min-height: 44px;
  }
}

.role {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.role__icon {
  flex: none;
  color: var(--acc);
}

.role__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.role__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.role__body {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.security {
  display: flex;
  gap: 12px;
}

.security__icon {
  flex: none;
  margin-top: 1px;
  color: var(--t2);
}

.security__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.security__title {
  font-size: var(--fs-small);
  font-weight: 500;
}

.security__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 1024px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
