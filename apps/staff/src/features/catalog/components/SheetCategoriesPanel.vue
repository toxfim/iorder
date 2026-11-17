<script setup lang="ts">
import type { ProductCategoryResponse, SheetCategoryResponse } from '@iorder/shared/staff-cost';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import { TRACKING_TYPES, describeCatalogError, type TrackingType } from '../domain/category-form';

// Sheet categories («Категория») that have no category yet. Each row starts with the company's
// rule computed by the api (phones IMEI, everything else SN; marking per the manager's list,
// [C] 2026-10-26); staff check it, change a row if needed and save them together.

const emit = defineEmits<{ saved: [categories: ProductCategoryResponse[]] }>();

const { t } = useI18n();
const { catalogApi } = useServices();
const id = useId();

const view = useAsyncView(() => catalogApi.listSheetCategories(), {
  isEmpty: (list) => list.items.length === 0,
});

interface RowChoice {
  trackingType: TrackingType;
  markingRequired: boolean;
}

const choices = ref(new Map<string, RowChoice>());
const savedNames = ref(new Set<string>());

const rows = computed<SheetCategoryResponse[]>(() =>
  (view.data.value?.items ?? []).filter((c) => !savedNames.value.has(c.name)),
);

const choiceOf = (row: SheetCategoryResponse): RowChoice =>
  choices.value.get(row.name) ?? {
    trackingType: row.suggestedTrackingType,
    markingRequired: row.suggestedMarkingRequired,
  };

function setChoice(row: SheetCategoryResponse, patch: Partial<RowChoice>): void {
  choices.value = new Map(choices.value).set(row.name, { ...choiceOf(row), ...patch });
}

const ready = computed(() =>
  rows.value.map((row) => ({
    name: row.name,
    trackingTypeDefault: choiceOf(row).trackingType,
    markingRequiredDefault: choiceOf(row).markingRequired,
  })),
);

const saving = ref(false);

async function save(): Promise<void> {
  if (saving.value || ready.value.length === 0) return;
  saving.value = true;
  try {
    const { items } = await catalogApi.createCategories({ items: ready.value });
    savedNames.value = new Set([...savedNames.value, ...ready.value.map((r) => r.name)]);
    emit('saved', items);
    showToast({ message: t('products.categories.sheet.saved', { count: items.length }) });
  } catch (caught) {
    showToast({ message: translateDescribed(t, describeCatalogError('createProduct', caught)) });
  } finally {
    saving.value = false;
  }
}

const errorText = computed(() =>
  translateDescribed(t, describeCatalogError('load', view.error.value)),
);
</script>

<template>
  <section
    v-if="view.state.value === 'error' || rows.length > 0"
    class="panel"
    :aria-labelledby="`${id}-title`"
    data-testid="sheet-categories"
  >
    <header class="panel__head">
      <h2 :id="`${id}-title`" class="panel__title">
        {{ t('products.categories.sheet.title', { count: rows.length }) }}
      </h2>
      <p class="panel__info">{{ t('products.categories.sheet.info') }}</p>
    </header>

    <p v-if="view.state.value === 'error'" class="panel__error" role="alert">
      {{ errorText }}
      <AppButton variant="secondary" size="sm" @click="view.reload">
        {{ t('products.categories.sheet.retry') }}
      </AppButton>
    </p>

    <ul v-else class="rows">
      <li v-for="row in rows" :key="row.name" class="row" data-testid="sheet-category-row">
        <span class="row__name">
          <b>{{ row.name }}</b>
          <span class="row__count">
            {{
              t('products.categories.productCount', { count: row.productCount }, row.productCount)
            }}
          </span>
        </span>
        <span class="row__controls">
          <span
            class="options"
            role="radiogroup"
            :aria-label="`${row.name}: ${t('products.categories.sheet.type')}`"
          >
            <label
              v-for="type in TRACKING_TYPES"
              :key="type"
              class="option"
              :class="{ 'option--on': choiceOf(row).trackingType === type }"
            >
              <input
                class="option__input"
                type="radio"
                :name="`${id}-${row.name}`"
                :value="type"
                :checked="choiceOf(row).trackingType === type"
                :disabled="saving"
                :data-testid="`sheet-tracking-${type}`"
                @change="setChoice(row, { trackingType: type })"
              />
              <span>{{ t(`products.categories.sheet.types.${type}`) }}</span>
            </label>
          </span>
          <label class="marking">
            <input
              class="marking__box"
              type="checkbox"
              :checked="choiceOf(row).markingRequired"
              :disabled="saving"
              data-testid="sheet-marking"
              @change="
                setChoice(row, {
                  markingRequired: ($event.target as HTMLInputElement).checked,
                })
              "
            />
            <span>{{ t('products.categories.sheet.marking') }}</span>
          </label>
        </span>
      </li>
    </ul>

    <footer v-if="view.state.value !== 'error'" class="panel__foot">
      <span class="panel__hint">
        {{ t('products.categories.sheet.rule') }}
      </span>
      <AppButton
        :disabled="ready.length === 0"
        :loading="saving"
        data-testid="sheet-save"
        @click="save"
      >
        {{ t('products.categories.sheet.save', { count: ready.length }) }}
      </AppButton>
    </footer>
  </section>
</template>

<style scoped>
/* A v8 card: 20px header (15px/600 title, 11px help), hairline-ruled rows, a ruled footer. */
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.panel__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 20px 16px;
}

.panel__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.panel__info,
.panel__hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.panel__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0 20px 20px;
  font-size: var(--fs-small);
}

.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 20px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
}

.row:hover {
  background: var(--hov);
}

.row__name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-weight: 500;
}

.row__count {
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--t2);
}

.row__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* v8 choice chips: a hairline ring; the chosen one takes the accent tint and an accent ring. */
.option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: var(--tap-min);
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.option--on {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc-fg);
}

.option:has(.option__input:focus-visible),
.marking:has(.marking__box:focus-visible) {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.option__input,
.marking__box {
  margin: 0;
  accent-color: var(--acc);
}

.marking {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: var(--tap-min);
  padding: 0 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  font-weight: 500;
  cursor: pointer;
}

.marking__box {
  width: 16px;
  height: 16px;
}

.panel__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--e8);
}
</style>
