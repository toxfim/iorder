<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { saveFile } from '@core/lib/save-file';
import { translateDescribed } from '@/features/pricing/domain/translate-error';

// "Mega report" of the Qoldiq page (owner request, 2026-11-10): every delivery of every product
// in one .xlsx built by the api. Shown to everyone who opens this page (the roles that see cost);
// the server enforces it. The file may take a few seconds, so the button says it is working and
// ignores a second press meanwhile.
const { t } = useI18n();
const { stockApi } = useServices();

const busy = ref(false);

async function download(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const file = await stockApi.downloadMegaReport();
    const name = file.fileName ?? 'Mega_report.xlsx';
    saveFile(file.blob, name);
    showToast({ message: t('staffCost.megaReport.downloaded', { name }) });
  } catch (caught) {
    showToast({ message: translateDescribed(t, describePricingError('stock', caught)) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="chip"
    :disabled="busy"
    :aria-busy="busy || undefined"
    :title="t('staffCost.megaReport.hint')"
    data-testid="mega-report"
    @click="download"
  >
    <span v-if="busy" class="chip__spinner" aria-hidden="true" />
    <StaffIcon v-else name="download" :size="16" class="chip__icon" />
    <span>{{ busy ? t('staffCost.megaReport.preparing') : t('staffCost.megaReport.button') }}</span>
  </button>
  <!-- The tooltip is not read on touch screens; the result is announced politely instead. -->
  <span class="sr-only" aria-live="polite">{{
    busy ? t('staffCost.megaReport.preparing') : ''
  }}</span>
</template>

<style scoped>
/* The page action chip of v8 (the same look as "Excel yuklab olish" on Narxlar): 40px, white,
   hairline ring. */
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.chip:hover:not(:disabled) {
  background: var(--f5);
}

.chip:active:not(:disabled) {
  transform: scale(0.98);
}

.chip:disabled {
  cursor: progress;
  color: var(--t2);
}

.chip:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.chip__icon {
  color: var(--t2);
}

.chip__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--e8);
  border-top-color: var(--acc);
  border-radius: 50%;
  animation: chip-spin 0.8s linear infinite;
}

@keyframes chip-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chip {
    transition: none;
  }

  .chip:active:not(:disabled) {
    transform: none;
  }

  .chip__spinner {
    animation-duration: 2.4s;
  }
}

@media (max-width: 720px) {
  .chip {
    flex: 1 1 auto;
  }
}

@media (pointer: coarse), (hover: none) {
  .chip {
    min-height: 44px;
  }
}
</style>
