<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { PIECE_UNIT, type PublishChangesRequest } from '@iorder/shared';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import TextField from '@core/components/ui/TextField.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { useFormat } from '@core/i18n/use-format';
import { decimalSeparatorFor } from '@core/lib/format';
import { ApiConflictError } from '@core/lib/api-errors';
import { describePricingError } from '@core/lib/price-errors';
import { formatTenthsPercent, priceHint } from '@/features/staff-cost/domain/price-hint';
import { useCostFormat } from '@/features/staff-cost/composables/use-cost-format';
import ProductPhotoManager from '@/features/product-images/components/ProductPhotoManager.vue';
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
  history: [productId: string];
  /** A staff-added product turns out to be goods the sheet knows: the owner opens the merge. */
  merge: [productId: string];
  /** A photo of the product was added, switched or removed: the owner refreshes its row. */
  photosChanged: [];
}>();

// Design v8 "Narxni o'zgartirish" / "Narx qo'yish": one product, one save. There are no drafts
// [C, 2026-10-28]: the save publishes the current list with this one change as a new version
// (hard rule 5), so customers see it at once and nothing is left half-saved.
const { t, locale: i18nLocale } = useI18n();
const { pricingApi, currentUser } = useServices();
// UI convenience only: the photo routes answer 403 to everyone else.
const photosVisible = computed(() => canManagePhotos(currentUser.user.value?.staffRoles ?? []));
const { formatMoneyWithCurrency, formatUnit } = useFormat();
const { formatUsd } = useCostFormat();

const raw = ref('');
// Both prices are entered in USD [owner 2026-10-29]: "Цена" and the optional "Отсрочка" (the price
// when paying in parts; empty = none). Customers see them in so'm at the current rate.
const rawDeferred = ref('');
// The recommended retail price [C, 2026-11-09]: optional, shown to the customer in the cart and
// never charged. The save replaces the whole item, so the field always holds the RRP to keep.
const rawRrp = ref('');
// The «Оптовик/Партнер» tier [C, owner 2026-11-11]: optional; without a sale price that tier's
// customers see the standard prices. The save always sends both, so the dialog owns them.
const rawWholesale = ref('');
const rawWholesaleDeferred = ref('');
// The «Alif factoring» tier [C, owner 2026-11-12]: optional, but WITHOUT a sale price the product
// is not offered to that tier at all (no fallback). Sent on every save like the wholesale pair.
const rawAlif = ref('');
const rawAlifDeferred = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);
const confirmRemove = ref(false);
// A photo request is running: the price save waits (one request of the dialog at a time).
const photoBusy = ref(false);

watch(
  () => [props.modelValue, props.product?.productId] as const,
  ([open]) => {
    if (!open) return;
    raw.value = props.product?.price ? toInputValue(props.product.price) : '';
    rawDeferred.value = props.product?.deferredPrice
      ? toInputValue(props.product.deferredPrice)
      : '';
    rawRrp.value = props.product?.rrp ? toInputValue(props.product.rrp) : '';
    rawWholesale.value = props.product?.wholesalePrice
      ? toInputValue(props.product.wholesalePrice)
      : '';
    rawWholesaleDeferred.value = props.product?.wholesaleDeferredPrice
      ? toInputValue(props.product.wholesaleDeferredPrice)
      : '';
    rawAlif.value = props.product?.alifPrice ? toInputValue(props.product.alifPrice) : '';
    rawAlifDeferred.value = props.product?.alifDeferredPrice
      ? toInputValue(props.product.alifDeferredPrice)
      : '';
    failure.value = null;
    confirmRemove.value = false;
    photoBusy.value = false;
  },
  { immediate: true },
);

const listed = computed(() => props.product?.listed === true);
const name = computed(() => (props.product ? pickName(props.product.names) : ''));
const parsed = computed(() => parsePriceInput(raw.value));
/** An optional price field: empty means "none", anything else must be a valid price. */
function parseOptionalPrice(text: string) {
  const result = parsePriceInput(text);
  if (result.ok) return { ok: true as const, value: result.value };
  return result.reason === 'empty' ? { ok: true as const, value: null } : result;
}
const parsedDeferred = computed(() => parseOptionalPrice(rawDeferred.value));
const parsedRrp = computed(() => parseOptionalPrice(rawRrp.value));
const parsedWholesale = computed(() => parseOptionalPrice(rawWholesale.value));
const parsedWholesaleDeferred = computed(() => parseOptionalPrice(rawWholesaleDeferred.value));
/** A wholesale deferred price needs a wholesale sale price (the api refuses it otherwise). */
const wholesaleOrphan = computed(
  () =>
    parsedWholesale.value.ok &&
    parsedWholesale.value.value === null &&
    parsedWholesaleDeferred.value.ok &&
    parsedWholesaleDeferred.value.value !== null,
);
const wholesaleValid = computed(
  () => parsedWholesale.value.ok && parsedWholesaleDeferred.value.ok && !wholesaleOrphan.value,
);
const parsedAlif = computed(() => parseOptionalPrice(rawAlif.value));
const parsedAlifDeferred = computed(() => parseOptionalPrice(rawAlifDeferred.value));
/** An Alif deferred price needs an Alif sale price (the api refuses it otherwise). */
const alifOrphan = computed(
  () =>
    parsedAlif.value.ok &&
    parsedAlif.value.value === null &&
    parsedAlifDeferred.value.ok &&
    parsedAlifDeferred.value.value !== null,
);
const alifValid = computed(
  () => parsedAlif.value.ok && parsedAlifDeferred.value.ok && !alifOrphan.value,
);
const sameOptional = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : sameMoney(a, b);
const unchanged = computed(
  () =>
    parsed.value.ok &&
    parsedDeferred.value.ok &&
    parsedRrp.value.ok &&
    props.product?.price != null &&
    sameMoney(parsed.value.value, props.product.price) &&
    // An older so'm price has no USD value: saving it in USD is a change.
    sameOptional(parsedDeferred.value.value, props.product.deferredPrice) &&
    sameOptional(parsedRrp.value.value, props.product.rrp) &&
    parsedWholesale.value.ok &&
    parsedWholesaleDeferred.value.ok &&
    sameOptional(parsedWholesale.value.value, props.product.wholesalePrice) &&
    sameOptional(parsedWholesaleDeferred.value.value, props.product.wholesaleDeferredPrice) &&
    parsedAlif.value.ok &&
    parsedAlifDeferred.value.ok &&
    sameOptional(parsedAlif.value.value, props.product.alifPrice) &&
    sameOptional(parsedAlifDeferred.value.value, props.product.alifDeferredPrice),
);
// The api refuses it (INACTIVE_PRODUCT); saying it here saves a round trip. Every product is
// sold by the piece, so nothing else can block a price.
const blocker = computed(() =>
  props.product?.isActive === false ? t('prices.row.inactive') : null,
);
const inputError = computed(() =>
  raw.value.trim() !== '' && !parsed.value.ok ? t('prices.row.invalid') : null,
);
const deferredError = computed(() => (parsedDeferred.value.ok ? null : t('prices.row.invalid')));
const rrpError = computed(() => (parsedRrp.value.ok ? null : t('prices.row.invalid')));
const wholesaleError = computed(() => (parsedWholesale.value.ok ? null : t('prices.row.invalid')));
const wholesaleDeferredError = computed(() => {
  if (!parsedWholesaleDeferred.value.ok) return t('prices.row.invalid');
  return wholesaleOrphan.value ? t('prices.dialog.wholesaleNeedsPrice') : null;
});
const alifError = computed(() => (parsedAlif.value.ok ? null : t('prices.row.invalid')));
const alifDeferredError = computed(() => {
  if (!parsedAlifDeferred.value.ok) return t('prices.row.invalid');
  return alifOrphan.value ? t('prices.dialog.alifNeedsPrice') : null;
});
const canSave = computed(
  () =>
    !busy.value &&
    !photoBusy.value &&
    blocker.value === null &&
    parsed.value.ok &&
    parsedDeferred.value.ok &&
    parsedRrp.value.ok &&
    wholesaleValid.value &&
    alifValid.value &&
    !unchanged.value,
);

// Markup against the latest USD cost: information only, a price below cost is not blocked.
const hint = computed(() => priceHint(raw.value, props.product?.latestCostUsd ?? null));
const hintText = computed(() => {
  const value = hint.value;
  if (!value) return t('prices.dialog.perUnit', { unit: formatUnit(PIECE_UNIT) });
  const separator = decimalSeparatorFor(i18nLocale.value);
  const markup = t('staffCost.unpriced.hint.markup', {
    markup: formatTenthsPercent(value.markupTenths, separator),
    margin: formatTenthsPercent(value.marginTenths, separator),
  });
  return value.belowCost ? `${t('staffCost.unpriced.hint.belowCost')} · ${markup}` : markup;
});

// The same markup hint for the wholesale price, when one is typed.
const wholesaleHint = computed(() =>
  rawWholesale.value.trim() === ''
    ? null
    : priceHint(rawWholesale.value, props.product?.latestCostUsd ?? null),
);
const wholesaleHintText = computed(() => {
  const value = wholesaleHint.value;
  if (!value) return t('prices.dialog.sectionWholesaleHint');
  const separator = decimalSeparatorFor(i18nLocale.value);
  const markup = t('staffCost.unpriced.hint.markup', {
    markup: formatTenthsPercent(value.markupTenths, separator),
    margin: formatTenthsPercent(value.marginTenths, separator),
  });
  return value.belowCost ? `${t('staffCost.unpriced.hint.belowCost')} · ${markup}` : markup;
});

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
  if (!canSave.value || !props.product || !parsed.value.ok || !parsedDeferred.value.ok) return;
  if (!parsedRrp.value.ok || !parsedWholesale.value.ok || !parsedWholesaleDeferred.value.ok) return;
  if (!parsedAlif.value.ok || !parsedAlifDeferred.value.ok) return;
  void publish({
    baseVersionNumber: props.baseVersionNumber,
    upserts: [
      {
        productId: props.product.productId,
        basePrice: parsed.value.value,
        deferredPrice: parsedDeferred.value.value,
        rrp: parsedRrp.value.value,
        wholesalePrice: parsedWholesale.value.value,
        wholesaleDeferredPrice: parsedWholesaleDeferred.value.value,
        alifPrice: parsedAlif.value.value,
        alifDeferredPrice: parsedAlifDeferred.value.value,
      },
    ],
    removedProductIds: [],
  });
}

function remove(): void {
  if (!props.product || busy.value) return;
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
    max-width="720px"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <form v-if="product" class="form" novalidate @submit.prevent="save">
      <div class="product">
        <span class="product__name">{{ name }}</span>
        <span class="mono product__code">{{ product.productCode }}</span>
      </div>

      <dl class="facts">
        <div class="fact">
          <dt>{{ t('prices.dialog.current') }}</dt>
          <dd class="num">
            {{ product.price !== null ? formatUsd(product.price) : '—' }}
          </dd>
          <dd v-if="!product.listed" class="fact__sub">
            {{ t('prices.dialog.notListed') }}
          </dd>
          <template v-else>
            <dd v-if="product.priceUzs !== null" class="fact__sub num" data-current-uzs>
              {{ formatMoneyWithCurrency(product.priceUzs) }}
            </dd>
            <dd v-if="product.deferredPrice !== null" class="fact__sub num" data-current-deferred>
              {{ t('prices.dialog.deferredShort') }}: {{ formatUsd(product.deferredPrice) }}
            </dd>
            <dd v-if="product.wholesalePrice !== null" class="fact__sub num" data-current-wholesale>
              {{ t('prices.dialog.wholesaleShort') }}: {{ formatUsd(product.wholesalePrice) }}
            </dd>
            <dd v-if="product.alifPrice !== null" class="fact__sub num" data-current-alif>
              {{ t('prices.dialog.alifShort') }}: {{ formatUsd(product.alifPrice) }}
            </dd>
            <dd v-if="product.rrp !== null" class="fact__sub num" data-current-rrp>
              {{ t('prices.dialog.rrpShort') }}: {{ formatUsd(product.rrp) }}
            </dd>
          </template>
        </div>
        <div class="fact">
          <dt>{{ t('staffCost.cost.column') }}</dt>
          <dd class="num">
            {{ product.latestCostUsd !== null ? formatUsd(product.latestCostUsd) : '—' }}
          </dd>
        </div>
      </dl>

      <div v-if="blocker" class="notice notice--warn" role="alert">
        <StaffIcon name="alert" :size="15" />
        <span class="notice__text">{{ blocker }}</span>
      </div>

      <fieldset class="sec" data-section="standard">
        <legend class="sec__head">{{ t('prices.dialog.sectionStandard') }}</legend>
        <div class="sec__fields">
          <div class="sec__field">
            <TextField
              v-model="raw"
              data-price-input
              :label="listed ? t('prices.dialog.newPrice') : t('prices.dialog.price')"
              :hint="inputError ? undefined : hintText"
              :error="inputError"
              inputmode="decimal"
              autocomplete="off"
              :disabled="busy || blocker !== null"
            />
            <p v-if="hint?.belowCost && !inputError" class="below" role="note">
              {{ t('staffCost.unpriced.hint.belowCost') }}
            </p>
          </div>

          <TextField
            v-model="rawDeferred"
            data-deferred-price-input
            :label="t('prices.dialog.deferredPrice')"
            :hint="deferredError ? undefined : t('prices.dialog.deferredHint')"
            :error="deferredError"
            inputmode="decimal"
            autocomplete="off"
            :disabled="busy || blocker !== null"
          />
        </div>
      </fieldset>

      <fieldset class="sec sec--tier" data-section="wholesale">
        <legend class="sec__head">{{ t('prices.dialog.sectionWholesale') }}</legend>
        <div class="sec__fields">
          <TextField
            v-model="rawWholesale"
            data-wholesale-price-input
            :label="t('prices.dialog.wholesalePrice')"
            :hint="wholesaleError ? undefined : wholesaleHintText"
            :error="wholesaleError"
            inputmode="decimal"
            autocomplete="off"
            :disabled="busy || blocker !== null"
          />
          <TextField
            v-model="rawWholesaleDeferred"
            data-wholesale-deferred-price-input
            :label="t('prices.dialog.wholesaleDeferredPrice')"
            :hint="wholesaleDeferredError ? undefined : t('prices.dialog.wholesaleDeferredHint')"
            :error="wholesaleDeferredError"
            inputmode="decimal"
            autocomplete="off"
            :disabled="busy || blocker !== null"
          />
        </div>
      </fieldset>

      <fieldset class="sec sec--tier" data-section="alif">
        <legend class="sec__head">{{ t('prices.dialog.sectionAlif') }}</legend>
        <div class="sec__fields">
          <TextField
            v-model="rawAlif"
            data-alif-price-input
            :label="t('prices.dialog.alifPrice')"
            :hint="alifError ? undefined : t('prices.dialog.sectionAlifHint')"
            :error="alifError"
            inputmode="decimal"
            autocomplete="off"
            :disabled="busy || blocker !== null"
          />
          <TextField
            v-model="rawAlifDeferred"
            data-alif-deferred-price-input
            :label="t('prices.dialog.alifDeferredPrice')"
            :hint="alifDeferredError ? undefined : t('prices.dialog.alifDeferredHint')"
            :error="alifDeferredError"
            inputmode="decimal"
            autocomplete="off"
            :disabled="busy || blocker !== null"
          />
        </div>
      </fieldset>

      <div class="extras">
        <TextField
          v-model="rawRrp"
          data-rrp-input
          :label="t('prices.dialog.rrp')"
          :hint="rrpError ? undefined : t('prices.dialog.rrpTiersHint')"
          :error="rrpError"
          inputmode="decimal"
          autocomplete="off"
          :disabled="busy || blocker !== null"
        />

        <p class="notice" role="note">
          <StaffIcon name="lock" :size="15" />{{ t('prices.dialog.publishNoteTiers') }}
        </p>
      </div>

      <p v-if="failure" class="notice notice--error" role="alert">{{ failure }}</p>

      <div v-if="confirmRemove" class="remove" role="group" :aria-label="t('prices.dialog.remove')">
        <span>{{ t('prices.dialog.removeQuestion') }}</span>
        <div class="remove__actions">
          <AppButton variant="secondary" size="sm" :disabled="busy" @click="confirmRemove = false">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton variant="danger" size="sm" :loading="busy" @click="remove">
            {{ t('prices.dialog.removeConfirm') }}
          </AppButton>
        </div>
      </div>
    </form>

    <!-- Below the price (the dialog's main task) and outside its form: a photo action never
         submits the price. -->
    <ProductPhotoManager
      v-if="product && photosVisible"
      class="photos"
      :product-code="product.productCode"
      :name="name"
      :disabled="busy"
      :after-change="() => emit('photosChanged')"
      :busy-change="(running: boolean) => (photoBusy = running)"
    />

    <template #footer>
      <div class="footer">
        <div class="footer__start">
          <AppButton
            v-if="listed && !confirmRemove"
            variant="ghost"
            size="sm"
            class="footer__remove"
            :disabled="busy"
            @click="confirmRemove = true"
          >
            <StaffIcon name="trash" :size="14" />{{ t('prices.dialog.remove') }}
          </AppButton>
          <AppButton
            v-if="listed && product"
            variant="ghost"
            size="sm"
            :disabled="busy"
            @click="product && emit('history', product.productId)"
          >
            <StaffIcon name="history" :size="14" />{{ t('prices.historyLink') }}
          </AppButton>
          <!-- Only a staff-added product (generated code) can be merged into a sheet product. -->
          <AppButton
            v-if="product?.codeGenerated && !confirmRemove"
            variant="ghost"
            size="sm"
            :disabled="busy"
            data-testid="merge-product"
            @click="product && emit('merge', product.productId)"
          >
            <StaffIcon name="link" :size="14" />{{ t('staffCost.merge.action') }}
          </AppButton>
        </div>
        <AppButton variant="secondary" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton :disabled="!canSave" :loading="busy && !confirmRemove" @click="save">
          {{ listed ? t('prices.dialog.save') : t('prices.dialog.add') }}
        </AppButton>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.product {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.product__name {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.product__code {
  font-size: var(--fs-meta);
  color: var(--t2);
}

/* v8: two grey fact tiles (current price, cost) above the input. The current price is wider:
   its other prices run on one wrapping line instead of a line each. */
.facts {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 8px;
  margin: 0;
}

.fact {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 2px 12px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.fact dt {
  flex-basis: 100%;
  font-size: var(--fs-group);
  color: var(--t2);
}

.fact dd {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}

.fact .fact__sub {
  flex-basis: auto;
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--t2);
}

/* Design 5A: one block per price tier; the wholesale one is tinted. */
.sec {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  margin: 0;
  padding: 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.sec--tier {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc-bg);
}

/* Цена and Отсрочка side by side where there is room, stacked on a phone. */
.sec__fields,
.extras {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  align-items: start;
  gap: 12px;
}

.sec__field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.sec__head {
  margin-bottom: 2px;
  padding: 0;
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t2);
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.notice__text {
  flex: 1 1 auto;
}

.notice :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.notice--warn {
  background: var(--amber-bg);
  color: var(--amber);
}

.notice--error {
  background: var(--red-bg);
  color: var(--red);
}

.below {
  margin: -8px 0 0;
  font-size: var(--fs-meta);
  color: var(--red);
}

.remove {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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

.photos {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--e8);
}

.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}

.footer__start {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-right: auto;
}

.footer__remove {
  color: var(--red);
}
</style>
