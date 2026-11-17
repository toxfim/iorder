<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { hasGeneratedProductCodePrefix } from '@iorder/shared';
import type { MergePreviewResponse, StockOverviewItem } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import SearchField from '@core/components/ui/SearchField.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import {
  describeMergeError,
  isStalePriceList,
  mergeTargetFacts,
} from '@/features/staff-cost/domain/manual-products';
import { pickName } from '../domain/localized-name';
import { translateDescribed } from '../domain/translate-error';

/** The staff-added product that is to become a sheet product. */
export interface MergeSource {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string;
}

/** A sheet product the dialog starts with (the "Sheetda bor" badge of the list). */
export interface MergeTargetHint {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string;
}

export interface ProductMerged {
  readonly sourceProductId: string;
  readonly sourceCode: string;
  readonly targetProductId: string;
  readonly targetCode: string;
  /** Null when the source had no price in the list (nothing was republished). */
  readonly versionNumber: number | null;
}

const props = defineProps<{
  modelValue: boolean;
  source: MergeSource | null;
  /** The target to start with; null = the person searches for one. */
  initialTarget: MergeTargetHint | null;
  /** The published version the merge is based on; null before the first publish. */
  baseVersionNumber: number | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  merged: [result: ProductMerged];
  stale: [];
}>();

// "Sheet tovari bilan birlashtirish" (design canvas 2026-11-09): a product staff added by hand
// turns out to be goods the sheet knows. The sheet product is searched in the stock list (every
// sheet product has deliveries there) or comes pre-filled from the "Sheetda bor" badge; the server's
// read-only preview says what the merge will do before the person confirms. The server decides.
const SEARCH_DEBOUNCE_MS = 250;

const { t } = useI18n();
const { pricingApi, stockApi } = useServices();
const { formatQuantity, formatUsd } = useCostFormat();

// --- the target search -------------------------------------------------------------------------

const query = ref('');
const searchOpen = ref(false);
type SearchState = 'loading' | 'ready' | 'error' | 'denied';
const searchState = ref<SearchState>('loading');
const searchError = ref('');
const results = shallowRef<readonly StockOverviewItem[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchRun = 0;

/** Sheet products only: active, with a sheet code (a generated code is never a merge target). */
const candidates = computed(() =>
  results.value.filter(
    (item) =>
      item.isActive &&
      !hasGeneratedProductCodePrefix(item.productCode) &&
      item.productId !== props.source?.productId &&
      item.productId !== targetId.value,
  ),
);

async function search(): Promise<void> {
  const mine = ++searchRun;
  searchState.value = 'loading';
  try {
    const text = query.value.trim();
    const answer = await stockApi.listStock(text === '' ? {} : { search: text });
    if (mine !== searchRun) return;
    results.value = answer.items;
    searchState.value = 'ready';
  } catch (caught) {
    if (mine !== searchRun) return;
    results.value = [];
    searchState.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    searchError.value = translateDescribed(t, describePricingError('stock', caught));
  }
}

watch(query, () => {
  searchOpen.value = true;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

const nameOf = (item: StockOverviewItem): string => pickName(item.names);

// --- the target and its preview -------------------------------------------------------------

const targetId = ref<string | null>(null);
const targetCode = ref<string>('');
type PreviewState = 'idle' | 'loading' | 'ready' | 'error';
const previewStatus = ref<PreviewState>('idle');
const preview = shallowRef<MergePreviewResponse | null>(null);
const previewError = ref<string | null>(null);
let previewRun = 0;

async function loadPreview(): Promise<void> {
  const source = props.source;
  const target = targetId.value;
  if (!source || target === null) return;
  const mine = ++previewRun;
  previewStatus.value = 'loading';
  previewError.value = null;
  try {
    const answer = await pricingApi.mergePreview(source.productId, target);
    if (mine !== previewRun) return;
    preview.value = answer;
    previewStatus.value = 'ready';
  } catch (caught) {
    if (mine !== previewRun) return;
    preview.value = null;
    previewError.value = translateDescribed(t, describeMergeError(caught));
    previewStatus.value = 'error';
  }
}

function chooseTarget(target: MergeTargetHint): void {
  targetId.value = target.productId;
  targetCode.value = target.productCode;
  searchOpen.value = false;
  query.value = '';
  void loadPreview();
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    query.value = '';
    results.value = [];
    failure.value = null;
    preview.value = null;
    previewError.value = null;
    previewStatus.value = 'idle';
    targetId.value = null;
    searchOpen.value = props.initialTarget === null;
    if (props.initialTarget) chooseTarget(props.initialTarget);
    void search();
  },
);

const sourceView = computed(() => preview.value?.source ?? null);
const targetView = computed(() => preview.value?.target ?? null);

const pricesText = (base: string | null, deferred: string | null): string => {
  if (base === null) return t('staffCost.merge.noPrice');
  if (deferred === null) return t('staffCost.merge.priceOnly', { base: formatUsd(base) });
  return t('staffCost.merge.prices', { base: formatUsd(base), deferred: formatUsd(deferred) });
};
const pricesList = (base: string | null, deferred: string | null): string =>
  deferred === null ? formatUsd(base) : `${formatUsd(base)} / ${formatUsd(deferred)}`;

const targetStockText = computed(() => {
  const target = targetView.value;
  if (!target) return '';
  const facts = mergeTargetFacts(target);
  if (facts.stock === null) return t('staffCost.merge.targetStockUnknown');
  const stock = formatQuantity(facts.stock);
  return facts.cost === null
    ? t('staffCost.merge.targetStock', { stock })
    : t('staffCost.merge.targetStockCost', { stock, cost: formatUsd(facts.cost) });
});

/** "Nima o'zgaradi": what the preview says will move, parts of 0 dropped. */
const checklist = computed(() => {
  const answer = preview.value;
  if (!answer) return [];
  const { source, target } = answer;
  const items: { text: string; muted?: boolean }[] = [];
  items.push({
    text:
      source.basePrice === null
        ? t('staffCost.merge.effects.noPrices', { code: source.productCode })
        : t('staffCost.merge.effects.prices', {
            prices: pricesList(source.basePrice, source.deferredPrice),
            code: target.productCode,
          }),
  });
  const parts: string[] = [];
  if (source.brandName !== null && target.brandName === null) {
    parts.push(t('staffCost.merge.parts.brand'));
  }
  parts.push(t('staffCost.merge.parts.name'));
  if (source.imageCount > 0) {
    parts.push(t('staffCost.merge.parts.photos', { count: source.imageCount }));
  }
  if (source.cartLineCount > 0) {
    parts.push(t('staffCost.merge.parts.cart', { count: source.cartLineCount }));
  }
  const joined = parts.join(', ');
  items.push({
    text: t('staffCost.merge.effects.moves', {
      parts: joined.charAt(0).toLocaleUpperCase() + joined.slice(1),
    }),
  });
  items.push({ text: t('staffCost.merge.effects.stock') });
  items.push({
    text: t('staffCost.merge.effects.orders', { code: source.productCode }),
    muted: true,
  });
  return items;
});

const footnote = computed(() => {
  const answer = preview.value;
  if (!answer) return '';
  const version =
    answer.nextVersionNumber === null
      ? t('staffCost.merge.noPublish')
      : t('staffCost.merge.publishes', { number: answer.nextVersionNumber });
  return `${t('staffCost.merge.irreversible')} · ${version}`;
});

// --- the merge ---------------------------------------------------------------------------------

const busy = ref(false);
const failure = ref<string | null>(null);
const canConfirm = computed(
  () => !busy.value && previewStatus.value === 'ready' && targetId.value !== null,
);

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}

async function confirm(): Promise<void> {
  const source = props.source;
  const target = targetId.value;
  if (!source || target === null || !canConfirm.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const result = await pricingApi.mergeProduct(source.productId, {
      baseVersionNumber: props.baseVersionNumber,
      targetProductId: target,
    });
    emit('merged', {
      sourceProductId: result.sourceProductId,
      sourceCode: source.productCode,
      targetProductId: result.targetProductId,
      targetCode: targetCode.value,
      versionNumber: result.version?.number ?? null,
    });
    emit('update:modelValue', false);
  } catch (caught) {
    failure.value = translateDescribed(t, describeMergeError(caught));
    if (isStalePriceList(caught)) emit('stale');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('staffCost.merge.title')"
    max-width="560px"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <template #title>
      <span class="title-icon"><StaffIcon name="link" :size="16" /></span>
      {{ t('staffCost.merge.title') }}
    </template>

    <div v-if="source" class="stack" data-testid="merge-dialog">
      <!-- The two products side by side: what leaves, what stays. -->
      <div class="pair">
        <div class="pcard pcard--source" data-testid="merge-source">
          <span class="pcard__head">
            <AppBadge tone="info">{{ t('staffCost.merge.manualPill') }}</AppBadge>
            <span class="pcard__note">{{ t('staffCost.merge.manualNote') }}</span>
          </span>
          <span class="pcard__name">{{ source.name }}</span>
          <span class="mono pcard__code">{{ source.productCode }}</span>
          <span class="pcard__line num">{{
            sourceView
              ? pricesText(sourceView.basePrice, sourceView.deferredPrice)
              : t('staffCost.merge.previewLoading')
          }}</span>
          <span class="pcard__line">{{ t('staffCost.merge.stockNotTracked') }}</span>
        </div>
        <span class="pair__arrow" aria-hidden="true"><StaffIcon name="arrow" :size="18" /></span>
        <div
          class="pcard pcard--target"
          :class="{ 'pcard--empty': targetId === null }"
          data-testid="merge-target"
        >
          <template v-if="targetId !== null">
            <span class="pcard__head">
              <AppBadge tone="accent">{{ t('staffCost.merge.sheetPill') }}</AppBadge>
              <span class="pcard__note">{{ t('staffCost.merge.sheetNote') }}</span>
            </span>
            <template v-if="targetView">
              <span class="pcard__name">{{ targetView.name }}</span>
              <span class="mono pcard__code">{{ targetView.productCode }}</span>
              <span class="pcard__line num">{{ targetStockText }}</span>
              <span class="pcard__line num">{{
                pricesText(targetView.basePrice, targetView.deferredPrice)
              }}</span>
            </template>
            <template v-else>
              <span class="pcard__name">{{ initialTarget?.name ?? '' }}</span>
              <span class="mono pcard__code">{{ targetCode }}</span>
              <span class="pcard__line" role="status">{{
                previewStatus === 'loading' ? t('staffCost.merge.previewLoading') : ''
              }}</span>
            </template>
          </template>
          <template v-else>
            <span class="pcard__head">
              <AppBadge tone="accent">{{ t('staffCost.merge.sheetPill') }}</AppBadge>
            </span>
            <span class="pcard__line">{{ t('staffCost.merge.noTarget') }}</span>
          </template>
        </div>
      </div>

      <p
        v-if="previewError"
        class="note note--error"
        role="alert"
        data-testid="merge-preview-error"
      >
        {{ previewError }}
      </p>

      <!-- Another (or the first) sheet product: the search over the stock list. -->
      <div class="search" @focusin="searchOpen = true">
        <span class="search__label">{{
          targetId === null ? t('staffCost.merge.pickTarget') : t('staffCost.merge.pickAnother')
        }}</span>
        <SearchField
          v-model="query"
          :placeholder="t('staffCost.merge.searchPlaceholder')"
          label-hidden
          data-testid="merge-search"
        />
        <template v-if="searchOpen">
          <p v-if="searchState === 'loading'" class="note" role="status">
            {{ t('staffCost.merge.searching') }}
          </p>
          <p v-else-if="searchState === 'denied'" class="note note--error" role="alert">
            {{ t('apiErrors.denied') }}
          </p>
          <p v-else-if="searchState === 'error'" class="note note--error" role="alert">
            {{ searchError }}
            <button type="button" class="link" @click="search">{{ t('state.retry') }}</button>
          </p>
          <p v-else-if="candidates.length === 0" class="note" role="status">
            {{
              results.length === 0 && query.trim() === ''
                ? t('staffCost.merge.noStock')
                : t('staffCost.merge.noMatch')
            }}
          </p>
          <ul v-else class="results" :aria-label="t('staffCost.merge.results')">
            <li v-for="item in candidates" :key="item.productId">
              <button
                type="button"
                class="result"
                :aria-label="
                  t('staffCost.merge.pick', { name: nameOf(item), code: item.productCode })
                "
                data-testid="merge-candidate"
                @click="
                  chooseTarget({
                    productId: item.productId,
                    productCode: item.productCode,
                    name: nameOf(item),
                  })
                "
              >
                <span class="result__text">
                  <span class="result__name">{{ nameOf(item) }}</span>
                  <span class="result__meta">
                    <span class="mono">{{ item.productCode }}</span>
                    <template v-if="item.category"> · {{ item.category }}</template>
                  </span>
                </span>
                <span class="result__stock num">
                  {{ t('staffCost.stock.column') }}:
                  {{ item.stockQuantity === null ? '—' : formatQuantity(item.stockQuantity) }}
                </span>
              </button>
            </li>
          </ul>
        </template>
      </div>

      <section
        v-if="checklist.length > 0"
        class="effects"
        :aria-label="t('staffCost.merge.effectsTitle')"
        data-testid="merge-effects"
      >
        <h3 class="effects__title">{{ t('staffCost.merge.effectsTitle') }}</h3>
        <ul class="effects__list">
          <li
            v-for="item in checklist"
            :key="item.text"
            class="effect"
            :class="{ 'effect--muted': item.muted }"
          >
            <StaffIcon name="check" :size="14" class="effect__icon" />
            <span>{{ item.text }}</span>
          </li>
        </ul>
      </section>

      <p v-if="failure" class="note note--error" role="alert">{{ failure }}</p>
    </div>

    <template #footer>
      <span v-if="footnote" class="footnote">{{ footnote }}</span>
      <AppButton variant="secondary" :disabled="busy" @click="close">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton
        :disabled="!canConfirm"
        :loading="busy"
        data-testid="merge-confirm"
        @click="confirm"
      >
        <StaffIcon name="link" :size="14" />{{ t('staffCost.merge.confirm') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-kbd);
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: 8px;
}

.pair__arrow {
  display: flex;
  align-items: center;
  color: var(--acc);
}

.pcard {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 12px;
  border-radius: var(--r-btn-sm);
}

.pcard--source {
  background: var(--f5);
}

.pcard--target {
  background: var(--w);
  box-shadow: inset 0 0 0 2px var(--acc);
}

.pcard--empty {
  box-shadow: inset 0 0 0 1px var(--e8);
}

.pcard__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.pcard__note,
.pcard__code,
.pcard__line {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.pcard__name {
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--font-mono);
}

.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.note--error {
  color: var(--red);
}

.link {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.search {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search__label {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink);
}

/* The field's own `flex: 1 1 260px` is meant for a toolbar row; in this column it would become a
   260px tall gap between the input and the results. */
.search :deep(.search) {
  flex: 0 0 auto;
  max-width: none;
}

.results {
  display: flex;
  flex-direction: column;
  max-height: 240px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border-radius: var(--r-row);
  box-shadow: inset 0 0 0 1px var(--e8);
  list-style: none;
}

.results li + li {
  border-top: 1px solid var(--e8);
}

.result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 8px 12px;
  border: 0;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  text-align: left;
  cursor: pointer;
}

.result:hover {
  background: var(--hov);
}

.result:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.result__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.result__name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.result__meta,
.result__stock {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.result__stock {
  flex: none;
}

.effects {
  padding: 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.effects__title {
  margin: 0 0 8px;
  font-size: var(--fs-small);
  font-weight: 600;
}

.effects__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-meta);
  color: var(--ink);
}

.effect {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.effect__icon {
  flex: none;
  margin-top: 1px;
  color: var(--green);
}

.effect--muted {
  color: var(--t2);
}

.effect--muted .effect__icon {
  color: var(--t3);
}

.footnote {
  flex: 1 1 auto;
  align-self: center;
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 560px) {
  .pair {
    grid-template-columns: 1fr;
  }

  .pair__arrow {
    justify-content: center;
    transform: rotate(90deg);
  }
}

@media (pointer: coarse) {
  .result {
    min-height: 56px;
  }
}
</style>
