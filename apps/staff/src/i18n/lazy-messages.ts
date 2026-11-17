import { watch } from 'vue';
import type { AppI18n, I18nLocale } from '@core/i18n';

interface LoadState {
  readonly loaded: Set<I18nLocale>;
  watching: boolean;
}

/**
 * Staff-only vocabulary (cost, accounting, delivery contacts...) is not part of the eager
 * catalogs (hard rule 7). It lives next to its feature, in a chunk with "staff" in its name, and
 * is merged into vue-i18n under `namespace` (or at the root when it is null) after a dynamic import, per locale, only for the staff
 * area. The returned function makes the labels available in the current language (and in Uzbek,
 * the fallback). After the first call a language switch loads the new language by itself. A failed
 * import is thrown to the caller (the router) and can be retried by the next navigation.
 */
export function createLazyMessages(
  namespace: string | null,
  loaders: Readonly<Record<I18nLocale, () => Promise<object>>>,
): (i18n: AppI18n) => Promise<void> {
  const states = new WeakMap<object, LoadState>();

  function stateOf(i18n: AppI18n): LoadState {
    let state = states.get(i18n);
    if (!state) {
      state = { loaded: new Set(), watching: false };
      states.set(i18n, state);
    }
    return state;
  }

  async function loadLocale(i18n: AppI18n, locale: I18nLocale): Promise<void> {
    const state = stateOf(i18n);
    if (state.loaded.has(locale)) return;
    const messages = await loaders[locale]();
    i18n.global.mergeLocaleMessage(
      locale,
      namespace === null ? messages : { [namespace]: messages },
    );
    state.loaded.add(locale);
  }

  return async function ensure(i18n: AppI18n): Promise<void> {
    const state = stateOf(i18n);
    if (!state.watching) {
      state.watching = true;
      watch(i18n.global.locale, (locale) => {
        // The language switch itself must not fail because a chunk is missing; the labels then
        // fall back to Uzbek, and the next staff navigation retries (and reports) the failure.
        void loadLocale(i18n, locale as I18nLocale).catch(() => undefined);
      });
    }
    await loadLocale(i18n, 'uz');
    await loadLocale(i18n, i18n.global.locale.value as I18nLocale);
  };
}
