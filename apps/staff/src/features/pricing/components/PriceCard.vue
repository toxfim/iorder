<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import type { PriceRowView } from '../domain/price-row-view';

// Narxlar card «C3·a · Silliqlangan» (approved 2026-11-18): the photo with a white price tag
// (sale price, "keyin" deferred) and the markup pill, then code · stock, the name on two lines,
// the «Ulgurji / Hamkor» and «Alif factoring» rows (price | deferred) and the action row
// (Tahrirlash, full width) at the same height in every card of a row. The upper part is one
// button: it opens the side panel (price and supply history). The row menu opens on a right
// click (or long press / Context Menu key); the "⋯" button stays only on touch screens, where
// iOS has no long-press menu event.
const props = defineProps<{
  view: PriceRowView;
  canEdit: boolean;
  /** The "keyin" price on the tag (hidden in the so'm view, as in the design). */
  showTagDeferred: boolean;
  menuOpen: boolean;
}>();
const emit = defineEmits<{
  open: [];
  edit: [];
  more: [anchor: HTMLElement];
  menu: [at: { x: number; y: number }, focusAfter: HTMLElement | null];
}>();

const { t } = useI18n();
const product = computed(() => `${props.view.row.productCode} ${props.view.name}`);
const photo = computed(() => props.view.row.imageLargeUrl ?? props.view.row.imageUrl);

// Text fields keep the browser's own menu; everything else on the card opens the row menu.
const NATIVE_MENU = 'input, textarea, select, [contenteditable="true"]';
function onContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest(NATIVE_MENU)) return;
  const card = event.currentTarget;
  if (!(card instanceof HTMLElement) || window.getSelection()?.toString()) return;
  event.preventDefault();
  const control = card.querySelector<HTMLElement>('.pc__open');
  // A key-made event has no pointer position: open under the card's control instead.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  const rect = (control ?? card).getBoundingClientRect();
  emit(
    'menu',
    fromKeyboard ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY },
    control,
  );
}

function onMore(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) emit('more', event.currentTarget);
}
</script>

<template>
  <div
    class="pc"
    :class="{ 'pc--muted': !view.row.isActive }"
    :data-product="view.row.productCode"
    @contextmenu="onContextMenu"
  >
    <button
      type="button"
      class="pc__open"
      :aria-label="t('prices.page.openLabel', { product })"
      @click="emit('open')"
    >
      <span class="pc__img">
        <img v-if="photo" :src="photo" alt="" loading="lazy" />
        <StaffIcon v-else name="package" :size="40" class="pc__noimg" />
        <span class="pc__tag" :class="{ 'pc__tag--below': view.belowCost }">
          <b class="pc__sale">{{ view.sale ?? '—' }}</b>
          <span v-if="showTagDeferred && view.deferred" class="pc__tagdef">{{
            t('prices.page.deferred', { price: view.deferred })
          }}</span>
        </span>
        <span
          v-if="view.markup"
          class="pill pc__markup"
          :class="view.belowCost ? 'pill--warn' : 'pill--ok'"
          :title="view.markup.full"
          >{{ view.markup.short }}</span
        >
      </span>
      <span class="pc__body">
        <span class="pc__top">
          <span class="mono pc__code">{{ view.row.productCode }}</span>
          <span v-if="view.stock" class="pc__stock" :class="`pc__stock--${view.stock.tone}`">{{
            view.stock.text
          }}</span>
          <span v-else-if="view.row.codeGenerated" class="pill pill--blue">{{
            t('prices.page.byOrderBadge')
          }}</span>
        </span>
        <span class="pc__name">{{ view.name }}</span>
        <span class="pc__tiers">
          <span class="pc__tier">
            <span class="pc__tiername"
              >{{ t('prices.page.wholesaleShort')
              }}<small v-if="view.wholesale.fromStandard">{{
                t('prices.page.standardPrices')
              }}</small></span
            >
            <b :class="{ pc__muted: view.wholesale.fromStandard }">{{
              view.wholesale.price ?? '—'
            }}</b>
            <b class="pc__def">{{ view.wholesale.deferred ?? '—' }}</b>
          </span>
          <span class="pc__tier">
            <span class="pc__tiername">{{ t('prices.page.alifShort') }}</span>
            <template v-if="view.alif">
              <b>{{ view.alif.price }}</b>
              <b class="pc__def">{{ view.alif.deferred ?? '—' }}</b>
            </template>
            <span v-else class="pc__off">{{ t('prices.page.notOffered') }}</span>
          </span>
        </span>
      </span>
    </button>
    <span class="pc__acts">
      <button
        v-if="canEdit"
        type="button"
        class="pc__act pc__act--accent"
        :aria-label="t('prices.page.editLabel', { product })"
        data-action="edit"
        @click="emit('edit')"
      >
        <StaffIcon name="pencil" :size="16" />{{ t('prices.page.edit') }}
      </button>
      <button
        type="button"
        class="pc__act pc__act--icon pc__act--touch"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :aria-label="t('prices.rowMenu.label', { code: view.row.productCode, name: view.name })"
        data-testid="row-menu-button"
        @click="onMore"
      >
        <StaffIcon name="more" :size="16" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.pc {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.pc:hover {
  border-color: var(--t3);
}

.pc:focus-within {
  border-color: var(--acc);
}

.pc__open {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pc__open:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.pc__img {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 132px;
  overflow: hidden;
  padding: 10px 10px 34px;
  background: var(--f5);
}

.pc__img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.pc__noimg {
  color: var(--t3);
}

.pc__tag {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: var(--sh-dropdown);
}

.pc__tag--below {
  border-color: var(--acc);
}

.pc__sale {
  font-size: 15px;
  letter-spacing: -0.01em;
  white-space: nowrap;
  color: var(--ink);
}

.pc__tag--below .pc__sale {
  color: var(--acc-fg);
}

.pc__tagdef {
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  white-space: nowrap;
  color: var(--blue);
}

.pc__markup {
  position: absolute;
  right: 8px;
  bottom: 10px;
}

.pc__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
}

.pc__top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-meta);
}

.mono {
  font-family: var(--font-mono);
}

.pc__code {
  color: var(--t2);
}

.pc__stock {
  font-weight: 600;
}

.pc__stock--ok {
  color: var(--green);
}

.pc__stock--low {
  color: var(--acc-fg);
}

.pc__stock--out {
  color: var(--red);
}

.pc__name {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.pc--muted .pc__name {
  color: var(--t2);
}

.pc__tiers {
  display: flex;
  flex-direction: column;
}

.pc__tier {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 76px;
  gap: 6px;
  align-items: baseline;
  padding: 3px 0;
  border-top: 1px dashed var(--ef);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.pc__tier b {
  font-family: var(--font-mono);
  font-weight: 500;
  text-align: right;
  white-space: nowrap;
  color: var(--ink);
}

.pc__tier .pc__def {
  color: var(--blue);
}

.pc__tier .pc__muted {
  font-style: italic;
  color: var(--t2);
}

.pc__tiername {
  display: flex;
  flex-direction: column;
}

.pc__tiername small {
  font-size: 10px;
  color: var(--t3);
}

.pc__off {
  grid-column: span 2;
  font-style: italic;
  text-align: right;
  color: var(--t2);
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

.pill--blue {
  background: var(--blue-bg);
  color: var(--blue);
}

.pc__acts {
  display: flex;
  gap: 6px;
  margin-top: auto;
  padding: 0 12px 10px;
}

.pc__act {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.pc__act:hover {
  background: var(--hov);
}

.pc__act:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.pc__act--accent {
  flex: 1;
  min-width: 0;
  border-color: var(--acc);
  background: var(--acc);
  color: var(--acc-on);
  font-weight: 600;
}

.pc__act--accent:hover {
  background: var(--acc-hover);
}

.pc__act--icon {
  width: 32px;
  padding: 0;
}

/* The right click replaces "⋯" for a mouse: the button stays only where there is none. */
.pc__act--touch {
  display: none;
}

@media (pointer: coarse) {
  .pc__act--touch {
    display: inline-flex;
  }
}

/* Below 1280px: three cards a row, the tag keeps only the price. */
@media (max-width: 1279px) {
  .pc__tagdef {
    display: none;
  }
}

@media (max-width: 1023px) {
  .pc__img {
    height: 112px;
    padding: 8px 8px 32px;
  }
}

@media (pointer: coarse) {
  .pc__act {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
