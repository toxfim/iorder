<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDropdown from '@core/components/ui/AppDropdown.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { isPageSize, PAGE_SIZES, pageSlice, pageWindow, type PageSize } from '../domain/pagination';

// The design's pager under the Qoldiq list: rows per page (10 / 25 / 50 / 100), the range shown,
// previous / next and numbered pages; a phone shows "2 / 10" between two large arrows instead of
// the numbers. The page holds the whole list, so a page change never asks the server.
const props = defineProps<{ total: number }>();
const page = defineModel<number>('page', { required: true });
const size = defineModel<PageSize>('size', { required: true });

const { t } = useI18n();

const slice = computed(() => pageSlice(props.total, page.value, size.value));
const items = computed(() => pageWindow(slice.value.page, slice.value.pages));
const sizeOptions = PAGE_SIZES.map((value) => ({
  value: String(value),
  label: t('staffCost.pager.sizeOption', { count: value }),
}));

function setSize(value: string | null): void {
  const next = Number(value);
  if (!isPageSize(next) || next === size.value) return;
  size.value = next;
  page.value = 0;
}

function go(target: number): void {
  page.value = Math.min(Math.max(0, target), slice.value.pages - 1);
}
</script>

<template>
  <nav class="pager" :aria-label="t('staffCost.pager.label')">
    <span class="pager__size">
      <span class="pager__sizelabel">{{ t('staffCost.pager.perPage') }}</span>
      <AppDropdown
        :model-value="String(size)"
        :options="sizeOptions"
        :label="t('staffCost.pager.perPageLabel', { count: size })"
        min-width="96px"
        data-testid="page-size"
        @update:model-value="setSize"
      />
    </span>
    <span class="pager__range num" data-testid="page-range">{{
      t('staffCost.pager.range', {
        from: total === 0 ? 0 : slice.start + 1,
        to: slice.end,
        total,
      })
    }}</span>
    <span class="pager__nav">
      <button
        type="button"
        class="pager__btn"
        :aria-label="t('staffCost.pager.previous')"
        :disabled="slice.page === 0"
        @click="go(slice.page - 1)"
      >
        <StaffIcon name="right" :size="16" class="pager__prev" />
      </button>
      <span class="pager__numbers">
        <template v-for="entry in items" :key="entry.kind === 'gap' ? entry.key : entry.page">
          <span v-if="entry.kind === 'gap'" class="pager__gap" aria-hidden="true">…</span>
          <button
            v-else
            type="button"
            class="pager__btn"
            :class="{ 'pager__btn--on': entry.page === slice.page }"
            :aria-current="entry.page === slice.page ? 'page' : undefined"
            :aria-label="t('staffCost.pager.page', { page: entry.page + 1 })"
            @click="go(entry.page)"
          >
            {{ entry.page + 1 }}
          </button>
        </template>
      </span>
      <span class="pager__compact num" aria-hidden="true"
        >{{ slice.page + 1 }} / {{ slice.pages }}</span
      >
      <button
        type="button"
        class="pager__btn"
        :aria-label="t('staffCost.pager.next')"
        :disabled="slice.page >= slice.pages - 1"
        @click="go(slice.page + 1)"
      >
        <StaffIcon name="right" :size="16" />
      </button>
    </span>
  </nav>
</template>

<style scoped>
.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}

.pager__size {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.pager__range {
  font-size: var(--fs-small);
  color: var(--t2);
}

.pager__nav,
.pager__numbers {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pager__nav {
  gap: 6px;
}

.pager__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 40px;
  padding: 0 8px;
  border: 1px solid var(--e8);
  border-radius: var(--r-btn-sm);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.pager__btn:hover:not(:disabled, .pager__btn--on) {
  background: var(--hov);
}

.pager__btn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.pager__btn:disabled {
  border-color: var(--ef);
  color: var(--t3);
  cursor: default;
}

.pager__btn--on {
  border-color: var(--btn-ink-bg);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.pager__prev {
  transform: rotate(180deg);
}

.pager__gap {
  min-width: 24px;
  text-align: center;
  color: var(--t3);
}

.pager__compact {
  display: none;
  min-width: 72px;
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  text-align: center;
  color: var(--t2);
}

/* Phone: the arrows on a line of their own around "2 / 10"; no numbers, no "per page" word. */
@media (max-width: 639px) {
  .pager {
    gap: 8px;
  }

  .pager__nav {
    order: -1;
    justify-content: space-between;
    width: 100%;
  }

  .pager__numbers,
  .pager__sizelabel {
    display: none;
  }

  .pager__compact {
    display: inline-block;
  }

  .pager__btn {
    min-width: 48px;
    height: 48px;
  }
}
</style>
