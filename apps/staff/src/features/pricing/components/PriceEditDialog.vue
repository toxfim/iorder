<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PublishChangesRequest } from '@iorder/shared';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { decimalSeparatorFor } from '@core/lib/format';
import { ApiConflictError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { formatTenthsPercent, priceHint } from '@/features/staff-cost/domain/price-hint';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import ProductPhotoManager from '@/features/product-images/components/ProductPhotoManager.vue';
import ProductThumb from '@/features/product-images/components/ProductThumb.vue';
import { canManagePhotos } from '@/features/staff-shell/price-access';
import { pickName } from '../domain/localized-name';
import { parsePriceInput, sameMoney, toInputValue } from '../domain/price-input';
import type { PriceTarget } from '../domain/price-target';
import { translateDescribed } from '../domain/translate-error';

export type { PriceTarget } from '../domain/price-target';

export interface PriceSaved {
  readonly productId: string;
  readonly versionNumber: number;
  /** Inactive products the publish dropped from the list (the api counts them). */
  readonly skippedInactiveCount: number;
}

const props = defineProps<{
  modelValue: boolean;
  product: PriceTarget | null;
  /** The published version the price is based on; null before the first publish. */
  baseVersionNumber: number | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  saved: [result: PriceSaved];
  /** Another version was published meanwhile: the owner reloads the list (new base version). */
  stale: [];
  /** A staff-added product turns out to be goods the sheet knows: the owner opens the merge. */
  merge: [productId: string];
  /** A photo of the product was added, switched or removed: the owner refreshes its row. */
  photosChanged: [];
}>();

// Design T3 (approved 2026-11-18) "Narxni o'zgartirish": the fields on the left, on the right what
// a save changes and why it cannot save yet. There are no drafts [C, 2026-10-28]: the save
// publishes the current list with this one change as a new version (hard rule 5).
const { t, locale: i18nLocale } = useI18n();
const { pricingApi, currentUser } = useServices();
// UI convenience only: the photo routes answer 403 to everyone else.
const photosVisible = computed(() => canManagePhotos(currentUser.user.value?.staffRoles ?? []));
const { formatUsd } = useCostFormat();

/** The seven USD fields of one item; the save replaces the whole item, so the dialog owns all. */
type FieldKey =
  | 'price'
  | 'deferredPrice'
  | 'wholesalePrice'
  | 'wholesaleDeferredPrice'
  | 'alifPrice'
  | 'alifDeferredPrice'
  | 'rrp';
const FIELD_KEYS: readonly FieldKey[] = [
  'price',
  'deferredPrice',
  'wholesalePrice',
  'wholesaleDeferredPrice',
  'alifPrice',
  'alifDeferredPrice',
  'rrp',
];
// The test hooks of each field, unchanged from the earlier dialog.
const FIELD_ATTR: Record<FieldKey, string> = {
  price: 'data-price-input',
  deferredPrice: 'data-deferred-price-input',
  wholesalePrice: 'data-wholesale-price-input',
  wholesaleDeferredPrice: 'data-wholesale-deferred-price-input',
  alifPrice: 'data-alif-price-input',
  alifDeferredPrice: 'data-alif-deferred-price-input',
  rrp: 'data-rrp-input',
};

const emptyRaw = (): Record<FieldKey, string> => ({
  price: '',
  deferredPrice: '',
  wholesalePrice: '',
  wholesaleDeferredPrice: '',
  alifPrice: '',
  alifDeferredPrice: '',
  rrp: '',
});
const raw = ref<Record<FieldKey, string>>(emptyRaw());
const busy = ref(false);
const failure = ref<string | null>(null);
const confirmRemove = ref(false);
// A photo request is running: the price save waits (one request of the dialog at a time).
const photoBusy = ref(false);

watch(
  // Two sources, compared one by one: a re-read of the same product (the merge below) must not
  // reset the fields.
  [() => props.modelValue, () => props.product?.productId],
  ([open]) => {
    if (!open) return;
    const next = emptyRaw();
    for (const key of FIELD_KEYS) {
      const value = props.product?.[key] ?? null;
      next[key] = value ? toInputValue(value) : '';
    }
    raw.value = next;
    failure.value = null;
    confirmRemove.value = false;
    photoBusy.value = false;
  },
  { immediate: true },
);

// The page re-reads the product after a refused save (someone published meanwhile) or a photo
// change. The fields the user has not touched take the fresh values, so a second save never puts a
// colleague's price back; the ones the user typed stay, and "before" shows the fresh value.
watch(
  () => props.product,
  (next, previous) => {
    if (!props.modelValue || !next || !previous || next.productId !== previous.productId) return;
    const merged = { ...raw.value };
    for (const key of FIELD_KEYS) {
      const old = previous[key] ? toInputValue(previous[key]) : '';
      if (merged[key] === old) merged[key] = next[key] ? toInputValue(next[key]) : '';
    }
    raw.value = merged;
  },
);

const listed = computed(() => props.product?.listed === true);
const name = computed(() => (props.product ? pickName(props.product.names) : ''));

type Parsed = { ok: true; value: string | null } | { ok: false };
/** Empty means "none"; anything else must be a valid price. */
function parseField(text: string): Parsed {
  const result = parsePriceInput(text);
  if (result.ok) return { ok: true, value: result.value };
  return result.reason === 'empty' ? { ok: true, value: null } : { ok: false };
}
const parsed = computed(
  () =>
    Object.fromEntries(FIELD_KEYS.map((key) => [key, parseField(raw.value[key])])) as Record<
      FieldKey,
      Parsed
    >,
);
const valueOf = (key: FieldKey): string | null => {
  const result = parsed.value[key];
  return result.ok ? result.value : null;
};
const sameOptional = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : sameMoney(a, b);
/** The field holds a valid value other than the saved one (an older so'm item has none in USD). */
const changed = (key: FieldKey): boolean =>
  parsed.value[key].ok && !sameOptional(valueOf(key), props.product?.[key] ?? null);

/** A tier's deferred price needs that tier's sale price (the api refuses it otherwise). */
const orphan = (sale: FieldKey, deferred: FieldKey): boolean =>
  parsed.value[sale].ok &&
  valueOf(sale) === null &&
  parsed.value[deferred].ok &&
  valueOf(deferred) !== null;

// The api refuses it (INACTIVE_PRODUCT); saying it here saves a round trip.
const blocker = computed(() =>
  props.product?.isActive === false ? t('prices.row.inactive') : null,
);

interface FieldError {
  readonly key: FieldKey;
  /** Under the field. */
  readonly short: string;
  /** In the summary on the right. */
  readonly full: string;
}
const errors = computed<FieldError[]>(() => {
  const list: FieldError[] = [];
  for (const key of FIELD_KEYS) {
    if (!parsed.value[key].ok) {
      list.push({
        key,
        short: t('prices.row.invalid'),
        full: t('prices.dialog.t3.invalidIn', { field: t(`prices.dialog.t3.diff.${key}`) }),
      });
    }
  }
  if (orphan('wholesalePrice', 'wholesaleDeferredPrice')) {
    list.push({
      key: 'wholesaleDeferredPrice',
      short: t('prices.dialog.wholesaleNeedsPrice'),
      full: t('prices.dialog.t3.wholesaleOrphan'),
    });
  }
  if (orphan('alifPrice', 'alifDeferredPrice')) {
    list.push({
      key: 'alifDeferredPrice',
      short: t('prices.dialog.alifNeedsPrice'),
      full: t('prices.dialog.t3.alifOrphan'),
    });
  }
  return list;
});
const errorOf = (key: FieldKey): FieldError | undefined => errors.value.find((e) => e.key === key);
// A wrong text in the main price is shown as soon as it is typed; an empty one only blocks.
const standardMissing = computed(() => parsed.value.price.ok && valueOf('price') === null);

/** One line of "what a save changes". */
interface DiffLine {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly tone?: 'good' | 'bad';
}
const separator = computed(() => decimalSeparatorFor(i18nLocale.value));
const usdOrNone = (value: string | null): string =>
  value === null ? t('prices.dialog.t3.noneWord') : formatUsd(value);
const diff = computed<DiffLine[]>(() => {
  const product = props.product;
  if (!product) return [];
  const lines: DiffLine[] = FIELD_KEYS.filter(changed).map((key) => ({
    key,
    label: t(`prices.dialog.t3.diff.${key}`),
    before: usdOrNone(product[key]),
    after: usdOrNone(valueOf(key)),
  }));
  // Markup against the latest USD cost: information only, a price below cost is not blocked.
  const cost = product.latestCostUsd;
  const newPrice = valueOf('price');
  if (changed('price') && cost !== null && newPrice !== null) {
    const before = product.price === null ? null : priceHint(product.price, cost);
    const after = priceHint(newPrice, cost);
    if (after) {
      lines.push({
        key: 'markup',
        label: t('prices.dialog.t3.diff.markup'),
        before: before
          ? formatTenthsPercent(before.markupTenths, separator.value)
          : t('prices.dialog.t3.noneWord'),
        after: formatTenthsPercent(after.markupTenths, separator.value),
        tone: after.belowCost ? 'bad' : 'good',
      });
    }
  }
  return lines;
});

const belowCost = computed(() => {
  const price = valueOf('price');
  const cost = props.product?.latestCostUsd ?? null;
  return price !== null && cost !== null && (priceHint(price, cost)?.belowCost ?? false);
});
/** Whether the Alif tier gains or loses the product (it sees only products with an Alif price). */
const alifReach = computed<'added' | 'removed' | null>(() => {
  if (!changed('alifPrice')) return null;
  const before = props.product?.alifPrice ?? null;
  const after = valueOf('alifPrice');
  if (before === null && after !== null) return 'added';
  if (before !== null && after === null) return 'removed';
  return null;
});
const wholesaleToStandard = computed(
  () =>
    changed('wholesalePrice') &&
    props.product?.wholesalePrice !== null &&
    valueOf('wholesalePrice') === null,
);

const unchanged = computed(
  () => props.product?.price != null && errors.value.length === 0 && diff.value.length === 0,
);
/** Why the save is closed, written on the button's hover; null = it can save. */
const saveReason = computed<string | null>(() => {
  if (blocker.value) return blocker.value;
  if (errors.value.length > 0) {
    return t('prices.dialog.t3.blockedErrors', { count: errors.value.length });
  }
  if (standardMissing.value) return t('prices.dialog.t3.blockedStandard');
  if (unchanged.value) return t('prices.dialog.t3.blockedUnchanged');
  return null;
});
const canSave = computed(() => !busy.value && !photoBusy.value && saveReason.value === null);
const saveReasonId = useId();
const nextVersion = computed(() => (props.baseVersionNumber ?? 0) + 1);

const disabled = computed(() => busy.value || blocker.value !== null);

/** The rows of the form: a tier with its sale and deferred field, then the RRP over both. */
const tiers = computed(() => [
  {
    key: 'standard',
    label: t('prices.dialog.t3.standard'),
    strong: true,
    sale: 'price' as const,
    deferred: 'deferredPrice' as const,
    salePlaceholder: '',
  },
  {
    key: 'wholesale',
    label: t('prices.dialog.t3.wholesale'),
    strong: false,
    sale: 'wholesalePrice' as const,
    deferred: 'wholesaleDeferredPrice' as const,
    // Without its own price the tier sees the standard one (fallback [P]).
    salePlaceholder: t('prices.dialog.t3.fallbackStandard'),
  },
  {
    key: 'alif',
    label: t('prices.dialog.t3.alif'),
    strong: false,
    sale: 'alifPrice' as const,
    deferred: 'alifDeferredPrice' as const,
    // Without an Alif price the product is not offered to that tier (no fallback).
    salePlaceholder: t('prices.dialog.t3.none'),
  },
]);

function fieldLabel(key: FieldKey): string {
  return t(`prices.dialog.t3.diff.${key}`);
}
function was(key: FieldKey): string | null {
  if (!changed(key)) return null;
  const before = props.product?.[key] ?? null;
  return before === null ? t('prices.dialog.t3.none') : toInputValue(before);
}

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}

async function publish(request: PublishChangesRequest): Promise<void> {
  const product = props.product;
  if (!product) return;
  busy.value = true;
  failure.value = null;
  try {
    const result = await pricingApi.publishChanges(request);
    emit('saved', {
      productId: product.productId,
      versionNumber: result.number,
      skippedInactiveCount: result.skippedInactiveCount,
    });
    emit('update:modelValue', false);
  } catch (caught) {
    failure.value = translateDescribed(t, describePricingError('publish', caught));
    if (caught instanceof ApiConflictError && caught.reason === 'PRICE_LIST_CHANGED') emit('stale');
  } finally {
    busy.value = false;
  }
}

function save(): void {
  const product = props.product;
  const basePrice = valueOf('price');
  if (!canSave.value || !product || basePrice === null) return;
  void publish({
    baseVersionNumber: props.baseVersionNumber,
    upserts: [
      {
        productId: product.productId,
        basePrice,
        deferredPrice: valueOf('deferredPrice'),
        rrp: valueOf('rrp'),
        wholesalePrice: valueOf('wholesalePrice'),
        wholesaleDeferredPrice: valueOf('wholesaleDeferredPrice'),
        alifPrice: valueOf('alifPrice'),
        alifDeferredPrice: valueOf('alifDeferredPrice'),
      },
    ],
    removedProductIds: [],
  });
}

function remove(): void {
  if (!props.product || busy.value || photoBusy.value) return;
  void publish({
    baseVersionNumber: props.baseVersionNumber,
    upserts: [],
    removedProductIds: [props.product.productId],
  });
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="listed ? t('prices.dialog.titleEdit') : t('prices.dialog.titleAdd')"
    max-width="900px"
    flush
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <template #header="{ titleId }">
      <div class="head">
        <span v-if="product" class="head__photo">
          <ProductThumb :src="product.imageUrl" :alt="name" :size="38" :zoomable="false" />
        </span>
        <span class="head__titles">
          <h2 :id="titleId" class="head__title">
            {{ listed ? t('prices.dialog.titleEdit') : t('prices.dialog.titleAdd') }}
          </h2>
          <span v-if="product" class="mono head__sub" data-testid="price-dialog-sub">
            {{ product.productCode }} · {{ name }}
            <template v-if="product.latestCostUsd !== null">
              ·
              {{ t('staffCost.pricesPage.costShort', { cost: formatUsd(product.latestCostUsd) }) }}
            </template>
          </span>
        </span>
        <button
          type="button"
          class="head__close"
          :aria-label="t('prices.dialog.t3.close')"
          :disabled="busy"
          @click="close"
        >
          <StaffIcon name="x" :size="16" />
        </button>
      </div>
    </template>

    <div v-if="product" class="t3">
      <form class="t3__form" novalidate @submit.prevent="save">
        <div v-if="blocker" class="note note--warn" role="alert">
          <StaffIcon name="alert" :size="15" />
          <span>{{ blocker }}</span>
        </div>

        <div class="f" role="group" :aria-label="t('prices.dialog.t3.fieldsLabel')">
          <span />
          <span class="lbl" aria-hidden="true">{{ t('prices.dialog.t3.colPrice') }}</span>
          <span class="lbl" aria-hidden="true">{{ t('prices.dialog.t3.colDeferred') }}</span>

          <template v-for="tier in tiers" :key="tier.key">
            <span class="tn" :class="{ 'tn--strong': tier.strong }">{{ tier.label }}</span>
            <label
              v-for="key in [tier.sale, tier.deferred]"
              :key="key"
              class="inp"
              :class="{
                'inp--chg': changed(key) && !errorOf(key),
                'inp--err': !!errorOf(key),
              }"
              v-bind="{ [FIELD_ATTR[key]]: '' }"
            >
              <span class="sr-only">{{ fieldLabel(key) }}</span>
              <input
                v-model="raw[key]"
                class="inp__field"
                inputmode="decimal"
                autocomplete="off"
                :placeholder="key === tier.sale ? tier.salePlaceholder : t('prices.dialog.t3.none')"
                :disabled="disabled"
                :aria-invalid="errorOf(key) ? 'true' : undefined"
              />
              <span v-if="was(key) !== null" class="was">{{ was(key) }}</span>
            </label>
            <template v-if="errorOf(tier.sale) || errorOf(tier.deferred)">
              <span :key="`${tier.key}-error-gap`" />
              <span :key="`${tier.key}-error`" class="err" role="alert">
                <StaffIcon name="alert" :size="14" />
                {{ (errorOf(tier.deferred) ?? errorOf(tier.sale))?.short }}
              </span>
            </template>
          </template>

          <span class="tn">{{ t('prices.dialog.t3.rrp') }}</span>
          <label
            class="inp inp--wide"
            :class="{ 'inp--chg': changed('rrp') && !errorOf('rrp'), 'inp--err': !!errorOf('rrp') }"
            data-rrp-input
          >
            <span class="sr-only">{{ fieldLabel('rrp') }}</span>
            <input
              v-model="raw.rrp"
              class="inp__field"
              inputmode="decimal"
              autocomplete="off"
              :placeholder="t('prices.dialog.t3.none')"
              :disabled="disabled"
              :aria-invalid="errorOf('rrp') ? 'true' : undefined"
            />
            <span v-if="was('rrp') !== null" class="was">{{ was('rrp') }}</span>
          </label>
        </div>

        <!-- Below the price (the dialog's main task): a photo action never submits the price. -->
        <ProductPhotoManager
          v-if="photosVisible"
          class="photos"
          :product-code="product.productCode"
          :name="name"
          :disabled="busy"
          :after-change="() => emit('photosChanged')"
          :busy-change="(running: boolean) => (photoBusy = running)"
        />
      </form>

      <aside class="t3__side" :aria-label="t('prices.dialog.t3.changesTitle')">
        <span class="lbl">{{ t('prices.dialog.t3.changesTitle') }}</span>
        <div class="diffs" data-testid="price-diff">
          <span v-if="diff.length === 0" class="diffs__none">{{
            t('prices.dialog.t3.noChanges')
          }}</span>
          <span v-for="line in diff" :key="line.key" class="diff" :data-diff="line.key">
            <span>{{ line.label }}</span>
            <span class="mono diff__o">{{ line.before }}</span>
            <span class="diff__arrow" aria-hidden="true">→</span>
            <span class="mono diff__n" :class="line.tone ? `diff__n--${line.tone}` : undefined">{{
              line.after
            }}</span>
          </span>
        </div>
        <div v-if="belowCost" class="note note--warn" role="note">
          <StaffIcon name="alert" :size="15" />
          <span>{{ t('staffCost.unpriced.hint.belowCost') }}</span>
        </div>
        <div v-if="alifReach" class="note note--info" role="note">
          <StaffIcon name="circlecheck" :size="15" />
          <span>{{ t(`prices.dialog.t3.alif_${alifReach}`) }}</span>
        </div>
        <div v-if="wholesaleToStandard" class="note note--info" role="note">
          <StaffIcon name="circlecheck" :size="15" />
          <span>{{ t('prices.dialog.t3.wholesaleToStandard') }}</span>
        </div>
        <div
          v-if="errors.length > 0"
          class="note note--bad"
          role="alert"
          data-testid="price-errors"
        >
          <StaffIcon name="alert" :size="15" />
          <span>{{
            t('prices.dialog.t3.errors', { count: errors.length, first: errors[0]?.full ?? '' })
          }}</span>
        </div>
        <p v-if="failure" class="note note--bad" role="alert">{{ failure }}</p>
        <span class="side__foot">{{ t('prices.dialog.t3.concurrency') }}</span>
      </aside>
    </div>

    <template #footer>
      <div v-if="confirmRemove" class="remove" role="group" :aria-label="t('prices.dialog.remove')">
        <span>{{ t('prices.dialog.removeQuestion') }}</span>
        <div class="remove__actions">
          <AppButton variant="secondary" size="sm" :disabled="busy" @click="confirmRemove = false">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton
            variant="danger"
            size="sm"
            :loading="busy"
            :disabled="photoBusy"
            @click="remove"
          >
            {{ t('prices.dialog.removeConfirm') }}
          </AppButton>
        </div>
      </div>
      <div v-else class="footer">
        <!-- The reason the save is closed, for keyboard and screen readers (the title is hover only). -->
        <span v-if="saveReason" :id="saveReasonId" class="sr-only">{{ saveReason }}</span>
        <AppButton
          v-if="listed"
          variant="secondary"
          class="footer__remove"
          :disabled="busy"
          @click="confirmRemove = true"
        >
          {{ t('prices.dialog.remove') }}
        </AppButton>
        <!-- Only a staff-added product (generated code) can be merged into a sheet product. -->
        <AppButton
          v-if="product?.codeGenerated"
          variant="ghost"
          :disabled="busy"
          data-testid="merge-product"
          @click="product && emit('merge', product.productId)"
        >
          <StaffIcon name="link" :size="14" />{{ t('staffCost.merge.action') }}
        </AppButton>
        <span class="footer__gap" />
        <AppButton variant="secondary" :disabled="busy" @click="close">
          {{ t('prices.dialog.t3.cancel') }}
        </AppButton>
        <!-- Closed for a reason (errors, nothing changed): aria-disabled, so it keeps focus and the
             reason reaches the keyboard and screen readers; native disabled only while busy. -->
        <AppButton
          class="footer__save"
          :disabled="busy || photoBusy"
          :soft-disabled="saveReason !== null"
          :loading="busy && !confirmRemove"
          :title="saveReason ?? undefined"
          :aria-describedby="saveReason ? saveReasonId : undefined"
          data-testid="price-save"
          @click="save"
        >
          {{
            listed
              ? t('prices.dialog.t3.saveVersion', { number: nextVersion })
              : t('prices.dialog.t3.addVersion', { number: nextVersion })
          }}
        </AppButton>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}

/* T3 header: photo, title with code · name · cost, close. */
.head {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.head__photo {
  display: flex;
  flex: none;
  padding: 3px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--ef);
}

.head__titles {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.head__title {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 700;
}

.head__sub {
  overflow: hidden;
  font-size: var(--fs-meta);
  font-weight: 400;
  color: var(--t2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.head__close:hover {
  background: var(--hov);
  color: inherit;
}

/* Fields left, "what changes" right (340px); one column on a narrow screen. */
.t3 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
}

.t3__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 18px 20px;
  border-right: 1px solid var(--ef);
}

.t3__side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 18px 20px;
  background: var(--f5);
}

@media (max-width: 759px) {
  .t3 {
    grid-template-columns: minmax(0, 1fr);
  }

  .t3__form {
    border-right: 0;
    border-bottom: 1px solid var(--ef);
  }
}

.lbl {
  font-size: var(--fs-group);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--t2);
}

.f {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

@media (max-width: 479px) {
  .f {
    grid-template-columns: 76px minmax(0, 1fr) minmax(0, 1fr);
  }
}

.tn {
  font-size: var(--fs-small);
  color: var(--t2);
}

.tn--strong {
  font-weight: 600;
  color: inherit;
}

.inp {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 44px;
  padding: 0 10px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: text;
}

.inp--wide {
  grid-column: span 2;
}

.inp:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    0 0 0 3px var(--acc-bg);
}

.inp--chg {
  background: var(--acc-bg);
}

.inp--err,
.inp--err:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--red),
    0 0 0 3px var(--red-bg);
}

.inp__field {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font-family: var(--font-mono);
  font-size: var(--fs-body);
  font-weight: 500;
}

.inp__field::placeholder {
  font-family: inherit;
  font-weight: 400;
  color: var(--t3);
}

.was {
  flex: none;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-group);
  color: var(--t3);
  text-decoration: line-through;
}

.err {
  display: flex;
  grid-column: span 2;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.diffs {
  display: flex;
  flex-direction: column;
}

.diffs__none {
  padding: 7px 0;
  border-top: 1px solid var(--ef);
  font-size: var(--fs-small);
  color: var(--t3);
}

.diff {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px 20px 84px;
  align-items: baseline;
  gap: 6px;
  padding: 7px 0;
  border-top: 1px solid var(--ef);
  font-size: var(--fs-small);
}

.diff__o {
  text-align: right;
  color: var(--t3);
  text-decoration: line-through;
}

.diff__arrow {
  color: var(--t3);
}

.diff__n {
  font-weight: 600;
  text-align: right;
}

.diff__n--good {
  color: var(--green);
}

.diff__n--bad {
  color: var(--red);
}

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-input);
  font-size: var(--fs-meta);
  line-height: 1.45;
}

.note :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.note--warn {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.note--info {
  background: var(--blue-bg);
  color: var(--blue);
}

.note--bad {
  background: var(--red-bg);
  color: var(--red);
}

.side__foot {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.photos {
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--ef);
}

.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

/* A phone: the removal on its own line, then Bekor and a wide save. */
@media (max-width: 599px) {
  .footer__remove {
    flex-basis: 100%;
  }

  .footer__gap {
    display: none;
  }

  .footer__save {
    flex: 1 1 auto;
  }
}

.footer__gap {
  flex: 1 1 auto;
}

:root[data-staff-app] .footer .footer__remove {
  color: var(--red);
  box-shadow: inset 0 0 0 1px var(--red-bg);
}

.remove {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.remove__actions {
  display: flex;
  gap: 8px;
}
</style>
