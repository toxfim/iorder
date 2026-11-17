<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDropdown from '@core/components/ui/AppDropdown.vue';
import { isLocale, LOCALE_NAMES } from '@core/i18n';
import { useLocale } from '@core/i18n/use-locale';
import OrderJourney from './OrderJourney.vue';
import BrandLogo from '@core/components/brand/BrandLogo.vue';
import './login.css';

defineProps<{
  audience: string;
  title: string;
  subtitle: string;
  note: string;
  footer: string;
  heroEyebrow: string;
  heroTitle: string;
  heroDescription: string;
  heroNote: string;
}>();
const { t } = useI18n();
const { locale, locales, setLocale } = useLocale();
const languageOptions = computed(() =>
  locales.map((value) => ({ value, label: LOCALE_NAMES[value] })),
);
function changeLocale(value: string): void {
  if (isLocale(value)) setLocale(value);
}
</script>
<template>
  <div class="auth-page">
    <header class="auth-page__header">
      <BrandLogo :height="36" />
      <AppDropdown
        class="auth-language"
        :model-value="locale"
        :options="languageOptions"
        :label="t('common.language')"
        min-width="148px"
        align="right"
        :teleport="false"
        show-selection-mark
        @update:model-value="changeLocale"
      />
    </header>
    <div class="auth-page__body">
      <aside class="auth-hero" aria-hidden="true">
        <p class="auth-eyebrow">{{ heroEyebrow }}</p>
        <h2>{{ heroTitle }}</h2>
        <p class="auth-hero__description">{{ heroDescription }}</p>
        <OrderJourney />
        <p class="auth-hero__note">{{ heroNote }}</p>
      </aside>
      <section class="auth-card" aria-labelledby="sign-in-title">
        <p class="auth-eyebrow">{{ audience }}</p>
        <div class="auth-card__heading">
          <h1 id="sign-in-title">{{ title }}</h1>
          <p>{{ subtitle }}</p>
        </div>
        <slot />
        <p class="auth-card__note">{{ note }}</p>
      </section>
    </div>
    <footer class="auth-page__footer">{{ footer }}</footer>
  </div>
</template>
