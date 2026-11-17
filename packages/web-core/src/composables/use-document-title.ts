import { onBeforeUnmount, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

const BRAND = 'iOrder.uz';

// What a page adds in front of the route title (an order number): several tabs of the same list
// are told apart in the browser's tab strip and history.
const detail = ref<string | null>(null);

/** Keeps <title> in step with the current route and language (route.meta.titleKey). */
export function useDocumentTitle(): void {
  const { t } = useI18n();
  const route = useRoute();

  watchEffect(() => {
    const key = route.meta.titleKey;
    const parts = [detail.value, key ? t(key) : null, BRAND].filter(Boolean);
    document.title = parts.join(' · ');
  });
}

/** A page puts its own name (such as an order number) before the route title while it is open. */
export function useDocumentTitleDetail(source: () => string | null | undefined): void {
  watchEffect(() => {
    detail.value = source() ?? null;
  });
  onBeforeUnmount(() => {
    detail.value = null;
  });
}
