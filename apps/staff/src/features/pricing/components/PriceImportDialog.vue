<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  PRICE_IMPORT_MAX_ROWS,
  PRICE_IMPORT_ROW_STATUSES,
  type PriceImportConfirmResponse,
  type PriceImportPreviewResponse,
  type PriceImportPreviewRow,
  type PriceImportRowIssue,
  type PriceImportRowStatus,
  type PriceImportTemplateKind,
} from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppBadge, { type BadgeTone } from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { saveFile } from '@core/lib/save-file';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import {
  ERROR_ROWS_CSV_COLUMNS,
  PREVIEW_ROWS_SHOWN,
  PRICE_IMPORT_ACCEPT,
  PRICE_IMPORT_MAX_MB,
  checkImportFile,
  errorRowsCsv,
  fileErrorOf,
  importableRows,
  invalidRowsOf,
  isStalePriceList,
  orderPreviewRows,
  replacesPrice,
  toConfirmRows,
} from '@/features/staff-cost/domain/manual-products';
import { translateDescribed } from '../domain/translate-error';

export interface PriceImported {
  readonly versionNumber: number;
  readonly createdCount: number;
  readonly updatedCount: number;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** Generated-code products in the list now: the filled template holds exactly these. */
    generatedCount?: number;
    /** The published version; the preview says which version the import will publish. */
    baseVersionNumber?: number | null;
  }>(),
  { generatedCount: 0, baseVersionNumber: null },
);
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  imported: [result: PriceImported];
  /** Another version was published meanwhile: the owner reloads the list. */
  stale: [];
}>();

// "Excel orqali yuklash" (design canvas 2026-11-09), three steps: the template and the file, the
// server's check of every row (nothing written yet), the result. Only the rows the check did not
// refuse are published; the server checks them again and publishes one new version.
const { t } = useI18n();
const { pricingApi } = useServices();
const { formatUsd } = useCostFormat();
const inputId = useId();

type Step = 'file' | 'preview' | 'done';
const step = ref<Step>('file');
const file = shallowRef<File | null>(null);
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

const previewing = ref(false);
const fileError = ref<string | null>(null);
const preview = shallowRef<PriceImportPreviewResponse | null>(null);
const showAll = ref(false);

const confirming = ref(false);
const confirmError = ref<string | null>(null);
const stale = ref(false);
/** Rows the confirm refused (by the file's row number), with the issues the server named. */
const refused = shallowRef<ReadonlyMap<number, readonly PriceImportRowIssue[]>>(new Map());
const result = shallowRef<PriceImportConfirmResponse | null>(null);

const downloading = ref<PriceImportTemplateKind | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    step.value = 'file';
    file.value = null;
    dragging.value = false;
    fileError.value = null;
    preview.value = null;
    showAll.value = false;
    confirmError.value = null;
    stale.value = false;
    refused.value = new Map();
    result.value = null;
  },
);

const busy = computed(() => previewing.value || confirming.value);

const fileText = (reason: string): string =>
  t(`staffCost.priceImport.fileErrors.${reason}`, {
    mb: PRICE_IMPORT_MAX_MB,
    rows: PRICE_IMPORT_MAX_ROWS,
  });

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}

// --- step 1: the template and the file ---------------------------------------------------------

async function downloadTemplate(kind: PriceImportTemplateKind): Promise<void> {
  if (downloading.value !== null) return;
  downloading.value = kind;
  try {
    const downloaded = await pricingApi.downloadImportTemplate(kind);
    const name = downloaded.fileName ?? `price-import-template-${kind}.xlsx`;
    saveFile(downloaded.blob, name);
    showToast({ message: t('staffCost.priceImport.templateDownloaded', { name }) });
  } catch (caught) {
    showToast({ message: translateDescribed(t, describePricingError('load', caught)) });
  } finally {
    downloading.value = null;
  }
}

/** The quick checks before the upload; the server reads the bytes and decides again. */
function takeFile(chosen: File | undefined): void {
  if (!chosen || busy.value) return;
  const problem = checkImportFile(chosen);
  if (problem) {
    file.value = null;
    fileError.value = fileText(problem);
    return;
  }
  fileError.value = null;
  file.value = chosen;
}

function onFile(event: Event): void {
  const target = event.target as HTMLInputElement;
  const chosen = target.files?.[0];
  // Cleared at once, so choosing the same file again after a fix fires `change` again.
  target.value = '';
  takeFile(chosen);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  takeFile(event.dataTransfer?.files[0]);
}

function removeFile(): void {
  if (busy.value) return;
  file.value = null;
  fileError.value = null;
}

async function runPreview(): Promise<void> {
  const chosen = file.value;
  if (!chosen || busy.value) return;
  previewing.value = true;
  fileError.value = null;
  confirmError.value = null;
  stale.value = false;
  refused.value = new Map();
  showAll.value = false;
  try {
    preview.value = await pricingApi.importPreview(chosen);
    step.value = 'preview';
  } catch (caught) {
    const reason = fileErrorOf(caught);
    fileError.value =
      reason === null
        ? translateDescribed(t, describePricingError('publish', caught))
        : fileText(reason);
    step.value = 'file';
  } finally {
    previewing.value = false;
  }
}

function chooseAnother(): void {
  if (busy.value) return;
  step.value = 'file';
  file.value = null;
  preview.value = null;
  confirmError.value = null;
  stale.value = false;
  refused.value = new Map();
}

// --- step 2: the check -------------------------------------------------------------------------

const rows = computed(() => preview.value?.rows ?? []);
const importable = computed(() => importableRows(rows.value));

/** The row's verdict as shown: the confirm's refusal wins over the preview's. */
const issuesOf = (row: PriceImportPreviewRow): readonly PriceImportRowIssue[] =>
  refused.value.get(row.rowNumber) ?? row.issues;
const isError = (row: PriceImportPreviewRow): boolean =>
  row.status === 'ERROR' || refused.value.has(row.rowNumber);
const statusOf = (row: PriceImportPreviewRow): PriceImportRowStatus =>
  isError(row) ? 'ERROR' : row.status;

const errorRows = computed(() => rows.value.filter(isError));
const ordered = computed(() => orderPreviewRows(rows.value, isError));
const shown = computed(() =>
  showAll.value ? ordered.value : ordered.value.slice(0, PREVIEW_ROWS_SHOWN),
);
const truncated = computed(() => ordered.value.length > PREVIEW_ROWS_SHOWN);

const summaryCards = computed(() => {
  const counts: Record<PriceImportRowStatus, number> = {
    NEW: 0,
    PRICE_CHANGED: 0,
    UNCHANGED: 0,
    ERROR: 0,
  };
  for (const row of rows.value) counts[statusOf(row)] += 1;
  return PRICE_IMPORT_ROW_STATUSES.map((status) => ({
    status,
    label: t(`staffCost.priceImport.summary.${status}`),
    count: counts[status],
  }));
});

const STATUS_TONE: Record<PriceImportRowStatus, BadgeTone> = {
  NEW: 'success',
  PRICE_CHANGED: 'info',
  UNCHANGED: 'muted',
  ERROR: 'danger',
};

const issueText = (row: PriceImportPreviewRow, issue: PriceImportRowIssue): string =>
  t(`staffCost.priceImport.issues.${issue}`, { brand: row.brandName ?? '' });
const issuesText = (row: PriceImportPreviewRow): string =>
  issuesOf(row)
    .map((issue) => issueText(row, issue))
    .join(' · ');
/** The grey (or amber) second line under a non-error row. */
const noteOf = (row: PriceImportPreviewRow): { text: string; warn: boolean } | null => {
  if (row.warnings.includes('SAME_NAME_EXISTS')) {
    return { text: t('staffCost.priceImport.warnings.SAME_NAME_EXISTS'), warn: true };
  }
  if (row.warnings.includes('DUPLICATE_NAME_IN_FILE')) {
    return { text: t('staffCost.priceImport.warnings.DUPLICATE_NAME_IN_FILE'), warn: true };
  }
  if (row.productCode === null) {
    return {
      text:
        row.brandName === null
          ? t('staffCost.priceImport.newRowNote')
          : t('staffCost.priceImport.newRowNoteBrand', { brand: row.brandName }),
      warn: false,
    };
  }
  return null;
};
const money = (value: string | null): string => (value === null ? '—' : formatUsd(value));
/** The template's columns as the first step names them, in the file's order. */
const TEMPLATE_COLUMNS = [
  'code',
  'name',
  'brand',
  'category',
  'price',
  'deferred',
  'rrp',
  'wholesale',
  'wholesaleDeferred',
  'alif',
  'alifDeferred',
] as const;
/** The file has the optional «Оптовик/Партнер» columns: only then the import sets them. */
const hasWholesale = computed(() => rows.value.some((row) => row.wholesaleGiven));
/** The same for the optional «Alif factoring» columns [C, owner 2026-11-12]. */
const hasAlif = computed(() => rows.value.some((row) => row.alifGiven));

const nextVersion = computed(() => (preview.value?.baseVersionNumber ?? 0) + 1);

const canConfirm = computed(
  () => !busy.value && preview.value !== null && importable.value.length > 0 && !stale.value,
);

function downloadErrors(): void {
  const csv = errorRowsCsv(
    errorRows.value,
    Object.fromEntries(
      ERROR_ROWS_CSV_COLUMNS.map((column) => [
        column,
        t(`staffCost.priceImport.csvColumns.${column}`),
      ]),
    ) as Record<(typeof ERROR_ROWS_CSV_COLUMNS)[number], string>,
    issuesText,
  );
  saveFile(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    t('staffCost.priceImport.errorsFileName'),
  );
}

async function confirm(): Promise<void> {
  const current = preview.value;
  if (!canConfirm.value || current === null) return;
  confirming.value = true;
  confirmError.value = null;
  refused.value = new Map();
  try {
    const answer = await pricingApi.importConfirm({
      baseVersionNumber: current.baseVersionNumber,
      rows: toConfirmRows(current.rows),
    });
    result.value = answer;
    step.value = 'done';
    emit('imported', {
      versionNumber: answer.version.number,
      createdCount: answer.createdCount,
      updatedCount: answer.updatedCount,
    });
  } catch (caught) {
    const invalid = invalidRowsOf(caught);
    if (invalid.length > 0) {
      // The api indexes the confirm request's rows, which are the importable preview rows in order.
      const sent = importable.value;
      refused.value = new Map(
        invalid.flatMap(({ index, issues }) => {
          const row = sent[index];
          return row ? [[row.rowNumber, issues] as const] : [];
        }),
      );
      confirmError.value = t('staffCost.priceImport.rowsInvalid', { count: invalid.length });
    } else if (isStalePriceList(caught)) {
      stale.value = true;
      confirmError.value = t('staffCost.priceImport.changed');
      emit('stale');
    } else {
      confirmError.value = translateDescribed(t, describePricingError('publish', caught));
    }
  } finally {
    confirming.value = false;
  }
}

const title = computed(() =>
  step.value === 'file'
    ? t('staffCost.priceImport.title')
    : step.value === 'preview'
      ? t('staffCost.priceImport.previewTitle')
      : t('staffCost.priceImport.resultTitle'),
);
const description = computed(() =>
  step.value === 'preview' && preview.value && file.value
    ? t('staffCost.priceImport.previewSubtitle', {
        name: file.value.name,
        count: preview.value.rows.length,
      })
    : undefined,
);
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    :description="description"
    :max-width="step === 'preview' ? '900px' : '560px'"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <!-- Step 1: the template and the file. -->
    <div v-if="step === 'file'" class="stack" data-testid="import-step-file">
      <section class="step">
        <h3 class="step__title">
          <span class="step__num" aria-hidden="true">{{ 1 }}</span
          >{{ t('staffCost.priceImport.step1') }}
        </h3>
        <div class="templates">
          <button
            type="button"
            class="tcard"
            :disabled="downloading !== null"
            :aria-busy="downloading === 'empty' || undefined"
            data-testid="import-template-empty"
            @click="downloadTemplate('empty')"
          >
            <StaffIcon name="download" :size="16" class="tcard__icon" />
            <span class="tcard__text">
              <span class="tcard__title">{{ t('staffCost.priceImport.emptyTemplate') }}</span>
              <span class="tcard__hint">{{ t('staffCost.priceImport.emptyTemplateHint') }}</span>
            </span>
          </button>
          <button
            type="button"
            class="tcard"
            :disabled="downloading !== null"
            :aria-busy="downloading === 'filled' || undefined"
            data-testid="import-template-filled"
            @click="downloadTemplate('filled')"
          >
            <StaffIcon name="download" :size="16" class="tcard__icon" />
            <span class="tcard__text">
              <span class="tcard__title">{{ t('staffCost.priceImport.filledTemplate') }}</span>
              <span class="tcard__hint">{{
                t('staffCost.priceImport.filledTemplateHint', { count: generatedCount })
              }}</span>
            </span>
          </button>
        </div>
        <ul class="cols" :aria-label="t('staffCost.priceImport.tableLabel')">
          <li v-for="column in TEMPLATE_COLUMNS" :key="column">
            <code class="col">{{ t(`staffCost.priceImport.templateColumns.${column}`) }}</code>
          </li>
        </ul>
      </section>

      <section class="step">
        <h3 class="step__title">
          <span class="step__num step__num--on" aria-hidden="true">{{ 2 }}</span
          >{{ t('staffCost.priceImport.step2') }}
        </h3>
        <input
          :id="inputId"
          ref="input"
          class="sr-only"
          type="file"
          :accept="PRICE_IMPORT_ACCEPT"
          :disabled="busy"
          data-testid="import-file"
          @change="onFile"
        />
        <button
          v-if="file === null"
          type="button"
          class="drop"
          :class="{ 'drop--over': dragging }"
          :disabled="busy"
          data-testid="import-choose"
          @click="input?.click()"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <StaffIcon name="upload" :size="18" class="drop__icon" />
          <span class="drop__title">{{ t('staffCost.priceImport.dropzone') }}</span>
          <span class="drop__hint">{{
            t('staffCost.priceImport.dropzoneHint', { mb: PRICE_IMPORT_MAX_MB })
          }}</span>
        </button>
        <div v-else class="filerow" data-testid="import-file-row">
          <StaffIcon name="file" :size="18" class="filerow__icon" />
          <span class="filerow__text">
            <span class="mono filerow__name">{{ file.name }}</span>
            <span class="filerow__state" role="status">{{
              previewing
                ? t('staffCost.priceImport.checking')
                : t('staffCost.priceImport.fileReady')
            }}</span>
            <span v-if="previewing" class="progress" aria-hidden="true"
              ><span class="progress__bar"
            /></span>
          </span>
          <button
            type="button"
            class="filerow__remove"
            :disabled="busy"
            :aria-label="t('staffCost.priceImport.removeFile')"
            @click="removeFile"
          >
            <StaffIcon name="x" :size="14" />
          </button>
        </div>
        <p v-if="fileError" class="notice notice--error" role="alert">{{ fileError }}</p>
      </section>

      <p class="hint">{{ t('staffCost.priceImport.note') }}</p>
    </div>

    <!-- Step 2: what the server read, row by row, the rows it will skip first. -->
    <div v-else-if="step === 'preview' && preview" class="stack" data-testid="import-step-preview">
      <ul class="summary" :aria-label="t('staffCost.priceImport.previewTitle')">
        <li
          v-for="card in summaryCards"
          :key="card.status"
          class="scard"
          :data-summary="card.status"
        >
          <span class="scard__dot" :class="`scard__dot--${card.status}`" aria-hidden="true" />
          <span class="scard__label">{{ card.label }}</span>
          <b class="scard__count num">{{ card.count }}</b>
        </li>
      </ul>

      <div class="scroll" role="region" :aria-label="t('staffCost.priceImport.tableLabel')">
        <table class="rows">
          <thead>
            <tr>
              <th scope="col" class="num">{{ t('staffCost.priceImport.columns.row') }}</th>
              <th scope="col">{{ t('staffCost.priceImport.columns.result') }}</th>
              <th scope="col">{{ t('staffCost.priceImport.columns.product') }}</th>
              <th scope="col">{{ t('staffCost.priceImport.columns.category') }}</th>
              <th scope="col" class="rows__end">{{ t('staffCost.priceImport.columns.price') }}</th>
              <th scope="col" class="rows__end">
                {{ t('staffCost.priceImport.columns.deferred') }}
              </th>
              <th scope="col" class="rows__end">{{ t('staffCost.priceImport.columns.rrp') }}</th>
              <template v-if="hasWholesale">
                <th scope="col" class="rows__end">
                  {{ t('staffCost.priceImport.columns.wholesale') }}
                </th>
                <th scope="col" class="rows__end">
                  {{ t('staffCost.priceImport.columns.wholesaleDeferred') }}
                </th>
              </template>
              <template v-if="hasAlif">
                <th scope="col" class="rows__end">
                  {{ t('staffCost.priceImport.columns.alif') }}
                </th>
                <th scope="col" class="rows__end">
                  {{ t('staffCost.priceImport.columns.alifDeferred') }}
                </th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in shown"
              :key="row.rowNumber"
              class="row"
              :class="{ 'row--error': isError(row) }"
              :data-row-status="statusOf(row)"
            >
              <td class="num rows__row">{{ row.rowNumber }}</td>
              <td>
                <AppBadge :tone="STATUS_TONE[statusOf(row)]">{{
                  t(`staffCost.priceImport.status.${statusOf(row)}`)
                }}</AppBadge>
              </td>
              <td class="row__name">
                <span class="row__title">{{ row.name }}</span>
                <span v-if="isError(row)" class="row__note row__note--error">{{
                  issuesText(row)
                }}</span>
                <template v-else>
                  <span
                    v-if="noteOf(row)"
                    class="row__note"
                    :class="{ 'row__note--warn': noteOf(row)?.warn }"
                    >{{ noteOf(row)?.text }}</span
                  >
                  <span v-else-if="row.productCode" class="row__note mono">{{
                    row.productCode
                  }}</span>
                </template>
              </td>
              <!-- The category a NEW product gets; an existing product's is never changed. -->
              <td class="row__category" data-row-category>{{ row.category ?? '—' }}</td>
              <td class="num rows__end">
                <!-- Struck through only when THIS price changes: a row may change in its RRP alone. -->
                <template
                  v-if="
                    row.status === 'PRICE_CHANGED' &&
                    replacesPrice(row.currentBasePrice, row.basePrice)
                  "
                >
                  <s class="was">{{ money(row.currentBasePrice) }}</s>
                  {{ money(row.basePrice) }}
                </template>
                <template v-else>{{ money(row.basePrice) }}</template>
              </td>
              <td class="num rows__end">{{ money(row.deferredPrice) }}</td>
              <td class="num rows__end" data-row-rrp>
                <template
                  v-if="row.status === 'PRICE_CHANGED' && replacesPrice(row.currentRrp, row.rrp)"
                >
                  <s class="was">{{ money(row.currentRrp) }}</s>
                  {{ money(row.rrp) }}
                </template>
                <template v-else>{{ money(row.rrp) }}</template>
              </td>
              <template v-if="hasWholesale">
                <td class="num rows__end" data-row-wholesale>
                  <template
                    v-if="
                      row.status === 'PRICE_CHANGED' &&
                      replacesPrice(row.currentWholesalePrice, row.wholesalePrice)
                    "
                  >
                    <s class="was">{{ money(row.currentWholesalePrice) }}</s>
                    {{ money(row.wholesalePrice) }}
                  </template>
                  <template v-else>{{ money(row.wholesalePrice) }}</template>
                </td>
                <td class="num rows__end" data-row-wholesale-deferred>
                  <template
                    v-if="
                      row.status === 'PRICE_CHANGED' &&
                      replacesPrice(row.currentWholesaleDeferredPrice, row.wholesaleDeferredPrice)
                    "
                  >
                    <s class="was">{{ money(row.currentWholesaleDeferredPrice) }}</s>
                    {{ money(row.wholesaleDeferredPrice) }}
                  </template>
                  <template v-else>{{ money(row.wholesaleDeferredPrice) }}</template>
                </td>
              </template>
              <template v-if="hasAlif">
                <td class="num rows__end" data-row-alif>
                  <template
                    v-if="
                      row.status === 'PRICE_CHANGED' &&
                      replacesPrice(row.currentAlifPrice, row.alifPrice)
                    "
                  >
                    <s class="was">{{ money(row.currentAlifPrice) }}</s>
                    {{ money(row.alifPrice) }}
                  </template>
                  <template v-else>{{ money(row.alifPrice) }}</template>
                </td>
                <td class="num rows__end" data-row-alif-deferred>
                  <template
                    v-if="
                      row.status === 'PRICE_CHANGED' &&
                      replacesPrice(row.currentAlifDeferredPrice, row.alifDeferredPrice)
                    "
                  >
                    <s class="was">{{ money(row.currentAlifDeferredPrice) }}</s>
                    {{ money(row.alifDeferredPrice) }}
                  </template>
                  <template v-else>{{ money(row.alifDeferredPrice) }}</template>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
        <div v-if="truncated" class="tfoot">
          <span>{{
            showAll
              ? t('staffCost.priceImport.shownRows', {
                  shown: ordered.length,
                  total: ordered.length,
                })
              : t('staffCost.priceImport.shownRows', {
                  shown: shown.length,
                  total: ordered.length,
                })
          }}</span>
          <button
            type="button"
            class="link"
            data-testid="import-show-all"
            @click="showAll = !showAll"
          >
            {{ showAll ? t('staffCost.priceImport.showLess') : t('staffCost.priceImport.showAll') }}
          </button>
        </div>
      </div>

      <div v-if="errorRows.length > 0" class="banner" role="status" data-testid="import-errors">
        <StaffIcon name="alert" :size="16" class="banner__icon" />
        <span class="banner__text">{{
          t('staffCost.priceImport.errorBanner', { count: errorRows.length })
        }}</span>
        <button
          type="button"
          class="link"
          data-testid="import-download-errors"
          @click="downloadErrors"
        >
          {{ t('staffCost.priceImport.downloadErrors') }}
        </button>
      </div>
      <p v-if="importable.length === 0" class="notice" role="status">
        {{ t('staffCost.priceImport.nothingToImport') }}
      </p>
      <p v-if="confirmError" class="notice notice--error" role="alert">{{ confirmError }}</p>
    </div>

    <!-- Step 3: the new version and the counts. -->
    <div v-else-if="step === 'done' && result" class="stack" data-testid="import-step-done">
      <p class="done__title">
        <StaffIcon name="circlecheck" :size="18" class="done__icon" />
        {{ t('staffCost.priceImport.done.title', { number: result.version.number }) }}
      </p>
      <ul class="summary">
        <li class="scard">
          <span class="scard__dot scard__dot--NEW" aria-hidden="true" />
          <span class="scard__label">{{ t('staffCost.priceImport.summary.NEW') }}</span>
          <b class="scard__count num">{{ result.createdCount }}</b>
        </li>
        <li class="scard">
          <span class="scard__dot scard__dot--PRICE_CHANGED" aria-hidden="true" />
          <span class="scard__label">{{ t('staffCost.priceImport.summary.PRICE_CHANGED') }}</span>
          <b class="scard__count num">{{ result.updatedCount }}</b>
        </li>
        <li class="scard">
          <span class="scard__dot scard__dot--UNCHANGED" aria-hidden="true" />
          <span class="scard__label">{{ t('staffCost.priceImport.summary.UNCHANGED') }}</span>
          <b class="scard__count num">{{ result.unchangedCount }}</b>
        </li>
      </ul>
    </div>

    <template #footer>
      <template v-if="step === 'file'">
        <AppButton variant="secondary" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton
          :disabled="file === null || busy"
          :loading="previewing"
          data-testid="import-check"
          @click="runPreview"
        >
          {{ t('staffCost.priceImport.check') }}
        </AppButton>
      </template>
      <template v-else-if="step === 'preview'">
        <span v-if="importable.length > 0 && !stale" class="footnote">{{
          t('staffCost.priceImport.publishNote', {
            count: importable.length,
            number: nextVersion,
          })
        }}</span>
        <AppButton
          variant="secondary"
          :disabled="busy"
          data-testid="import-back"
          @click="chooseAnother"
        >
          {{ t('staffCost.priceImport.back') }}
        </AppButton>
        <AppButton
          v-if="stale"
          :loading="previewing"
          data-testid="import-recheck"
          @click="runPreview"
        >
          {{ t('staffCost.priceImport.recheck') }}
        </AppButton>
        <AppButton
          v-else
          :disabled="!canConfirm"
          :loading="confirming"
          data-testid="import-confirm"
          @click="confirm"
        >
          {{
            confirming ? t('staffCost.priceImport.confirming') : t('staffCost.priceImport.confirm')
          }}
        </AppButton>
      </template>
      <template v-else>
        <AppButton data-testid="import-close" @click="close">
          {{ t('staffCost.priceImport.close') }}
        </AppButton>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* --- step 1 --- */
.step {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.step__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.step__num {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ef);
  color: var(--t2);
  font-size: var(--fs-group);
  font-weight: 600;
}

.step__num--on {
  background: var(--acc);
  color: var(--acc-on);
}

.templates {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.tcard {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tcard:hover:not(:disabled) {
  background: var(--f5);
}

.tcard:focus-visible,
.drop:focus-visible,
.filerow__remove:focus-visible,
.link:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

/* Disabled (a download in flight): dimmed with text tokens, not opacity (dark-mode audit). */
.tcard:disabled {
  cursor: default;
  color: var(--b5);
}

.tcard:disabled .tcard__icon,
.tcard:disabled .tcard__hint {
  color: var(--b5);
}

.tcard__icon {
  flex: none;
  color: var(--t2);
}

.tcard__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tcard__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.tcard__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.col {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--r-kbd);
  background: var(--f5);
  color: var(--t2);
  font-family: var(--font-mono);
  font-size: var(--fs-group);
}

.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 22px 16px;
  border: 1px dashed var(--d9);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}

.drop:hover:not(:disabled),
.drop--over {
  border-color: var(--acc);
  background: var(--acc-bg3);
}

.drop__icon {
  color: var(--t2);
}

.drop__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.drop__hint {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.filerow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.filerow__icon {
  flex: none;
  color: var(--t2);
}

.filerow__text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.filerow__name {
  font-size: var(--fs-small);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filerow__state {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.filerow__remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--r-kbd);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.filerow__remove:hover:not(:disabled) {
  background: var(--e8);
  color: var(--ink);
}

.progress {
  display: block;
  height: 3px;
  margin-top: 2px;
  border-radius: 2px;
  background: var(--e8);
  overflow: hidden;
}

.progress__bar {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: 2px;
  background: var(--acc);
  animation: slide 1.1s ease-in-out infinite;
}

@keyframes slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(260%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress__bar {
    width: 100%;
    animation: none;
  }
}

/* --- step 2 --- */
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.scard {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.scard__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.scard__dot--NEW {
  background: var(--green);
}

.scard__dot--PRICE_CHANGED {
  background: var(--blue, var(--acc));
}

.scard__dot--UNCHANGED {
  background: var(--t3);
}

.scard__dot--ERROR {
  background: var(--red);
}

.scard__label {
  flex: 1 1 auto;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.scard__count {
  font-size: var(--fs-body);
}

/* The table scrolls sideways on a phone instead of squeezing the name column. */
.scroll {
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.rows {
  width: 100%;
  /* Seven columns since the category and the RRP [C, 2026-11-09]. */
  min-width: 760px;
  border-collapse: collapse;
  font-size: var(--fs-small);
}

.rows th,
.rows td {
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.rows th {
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--t2);
  background: var(--f5);
  white-space: nowrap;
}

.rows tbody tr + tr td {
  border-top: 1px solid var(--e8);
}

.rows__end {
  text-align: right;
  white-space: nowrap;
}

.rows__row {
  color: var(--t2);
}

.row--error td {
  background: var(--red-bg);
}

.row__name {
  min-width: 220px;
}

/* Free text of up to 200 characters: it wraps inside its column instead of widening the table. */
.row__category {
  max-width: 160px;
  color: var(--t2);
  overflow-wrap: anywhere;
}

.row__title {
  display: block;
  font-weight: 500;
}

.row__note {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.row__note--warn,
.row__note--error {
  color: var(--red);
}

.was {
  margin-right: 6px;
  color: var(--t3);
}

.mono {
  font-family: var(--font-mono);
}

.tfoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  cursor: pointer;
}

.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-meta);
}

.banner__icon {
  flex: none;
}

.banner__text {
  flex: 1 1 240px;
}

.notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.notice--error {
  background: var(--red-bg);
  color: var(--red);
}

.footnote {
  flex: 1 1 auto;
  align-self: center;
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* --- step 3 --- */
.done__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}

.done__icon {
  color: var(--green);
}

@media (max-width: 640px) {
  .templates {
    grid-template-columns: 1fr;
  }

  .summary {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
