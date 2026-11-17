import type { ComposerTranslation } from 'vue-i18n';

/** "Narxlar saqlandi · v15 · Samsung A15, 1 ta nofaol tovar ro'yxatdan chiqarildi" */
export function savedMessage(
  t: ComposerTranslation,
  result: { readonly versionNumber: number; readonly skippedInactiveCount: number },
  productName: string | null,
): string {
  const base = t('prices.saved', { number: result.versionNumber });
  const named = productName ? `${base} · ${productName}` : base;
  const skipped = result.skippedInactiveCount;
  return skipped > 0 ? `${named}, ${t('prices.skipped', { count: skipped }, skipped)}` : named;
}
