import { LOCALES, type Locale } from '@iorder/shared';
import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { writeStorage } from '@core/lib/safe-storage';
import { LOCALE_STORAGE_KEY, toI18nLocale } from './index';

export interface UseLocale {
  readonly locale: ComputedRef<Locale>;
  readonly locales: readonly Locale[];
  setLocale: (locale: Locale) => void;
}

export function useLocale(): UseLocale {
  const { locale: current } = useI18n({ useScope: 'global' });

  const locale = computed<Locale>(() => {
    const found = LOCALES.find((l) => toI18nLocale(l) === current.value);
    return found ?? LOCALES[0];
  });

  function setLocale(next: Locale): void {
    current.value = toI18nLocale(next);
    document.documentElement.lang = toI18nLocale(next);
    writeStorage(LOCALE_STORAGE_KEY, next);
  }

  return { locale, locales: LOCALES, setLocale };
}
