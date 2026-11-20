<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PriceRowView } from '../domain/price-row-view';

// The phone row of Narxlar (design 390, approved 2026-11-19): photo, name, code · stock, then the
// wholesale and deferred prices on the left and the sale price with the markup on the right. The
// whole row is one button: it opens "Narxni o'zgartirish" for the people who change prices and
// the side panel for everyone else.
const props = defineProps<{ view: PriceRowView; canEdit: boolean }>();
const emit = defineEmits<{ press: [] }>();

const { t } = useI18n();
const label = computed(() => {
  const product = `${props.view.row.productCode} ${props.view.name}`;
  return props.canEdit
    ? t('prices.page.editLabel', { product })
    : t('prices.page.openLabel', { product });
});
const photo = computed(() => props.view.row.imageUrl);
</script>

<template>
  <button
    type="button"
    class="pm"
    :class="{ 'pm--muted': !view.row.isActive }"
    :aria-label="label"
    :data-product="view.row.productCode"
    @click="emit('press')"
  >
    <span class="pm__head">
      <span class="pm__thumb"><img v-if="photo" :src="photo" alt="" loading="lazy" /></span>
      <span class="pm__titles">
        <span class="pm__name">{{ view.name }}</span>
        <span class="pm__meta mono"
          >{{ view.row.productCode
          }}<template v-if="view.stock">
            ·
            <span class="pm__stock" :class="`pm__stock--${view.stock.tone}`">{{
              view.stock.text
            }}</span></template
          ><template v-else-if="view.row.codeGenerated">
            · {{ t('prices.page.byOrderBadge') }}</template
          ></span
        >
      </span>
    </span>
    <span class="pm__foot">
      <span class="pm__tiers">
        <span
          >{{ t('prices.page.wholesaleShort') }}
          <b class="mono" :class="{ pm__muted: view.wholesale.fromStandard }">{{
            view.wholesale.price ?? '—'
          }}</b></span
        >
        <span
          >{{ t('prices.page.deferredLabel') }}
          <b class="mono pm__def">{{ view.deferred ?? '—' }}</b></span
        >
      </span>
      <span class="pm__price">
        <b class="pm__sale" :class="{ 'pm__sale--below': view.belowCost }">{{
          view.sale ?? '—'
        }}</b>
        <span
          v-if="view.markup"
          class="pill"
          :class="view.belowCost ? 'pill--warn' : 'pill--ok'"
          :title="view.markup.full"
          >{{ view.markup.short }}</span
        >
      </span>
    </span>
  </button>
</template>

<style scoped>
.pm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pm:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.pm__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pm__thumb {
  display: flex;
  flex: none;
  width: 56px;
  height: 56px;
  overflow: hidden;
  padding: 3px;
  border: 1px solid var(--ef);
  border-radius: var(--r-input);
  background: var(--w);
}

.pm__thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.pm__titles {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.pm__name {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.pm--muted .pm__name {
  color: var(--t2);
}

.mono {
  font-family: var(--font-mono);
}

.pm__meta {
  font-size: var(--fs-group);
  color: var(--t2);
}

.pm__stock {
  font-weight: 600;
}

.pm__stock--ok {
  color: var(--green);
}

.pm__stock--low {
  color: var(--acc-fg);
}

.pm__stock--out {
  color: var(--red);
}

.pm__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
}

.pm__tiers {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.pm__tiers b {
  font-weight: 500;
  color: var(--ink);
}

.pm__tiers .pm__muted {
  font-style: italic;
  color: var(--t2);
}

.pm__tiers .pm__def {
  color: var(--blue);
}

.pm__price {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.pm__sale {
  font-size: 20px;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.pm__sale--below {
  color: var(--acc-fg);
}

.pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-group);
  font-weight: 500;
  white-space: nowrap;
}

.pill--ok {
  background: var(--green-bg);
  color: var(--green);
}

.pill--warn {
  background: var(--acc-bg);
  color: var(--acc-fg);
}
</style>
