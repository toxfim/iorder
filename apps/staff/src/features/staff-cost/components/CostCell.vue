<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCostFormat } from '../composables/use-cost-format';
import type { DeliveryView } from '../domain/cost-view';

// Latest delivery cost: dollars on top, so'm below (v1). Hovering OR focusing the dollar amount
// shows the last deliveries in a tooltip; clicking falls through to the row, which opens the
// side panel with the full supply history. WCAG 1.4.13: the tooltip stays open while the pointer
// moves onto it (hoverable), until hover and focus leave (persistent), and Escape closes it
// (dismissable) while the trigger or the tooltip has focus or the pointer is over either.
const props = defineProps<{
  usd: string | null;
  uzs: string | null;
  /** Rate of the delivery behind the so'm figure (the latest one). */
  rate: string | null;
  recent: readonly DeliveryView[];
  /** Names the control for assistive technology. */
  productCode: string;
}>();

const { t } = useI18n();
const { formatUsd, formatUzsWithCurrency, formatRate, formatUzs, formatDate } = useCostFormat();

// The so'm figure uses the rate of that delivery, which differs from the current rate in the
// header; say so next to it so nobody reads the two against each other (F-14).
const deliveryRate = computed(() => props.rate);

const tooltipId = useId();
const trigger = ref<HTMLElement | null>(null);
const open = ref(false);
const position = ref<{ top?: string; bottom?: string; right: string }>({ right: '16px' });

// The table scrolls horizontally, which would clip an absolutely placed tooltip, so it is
// teleported to the body and placed from the trigger's rectangle.
const TOOLTIP_HEIGHT_ESTIMATE = 280;
// Time to cross the gap between the trigger and the tooltip with the pointer.
const LEAVE_DELAY_MS = 150;

const hover = { trigger: false, tip: false };
const focus = { trigger: false, tip: false };
let dismissed = false;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

function place(): void {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  // Scrolled out of view: nothing left for the tooltip to point at.
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    close();
    return;
  }
  const right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  position.value =
    rect.bottom + TOOLTIP_HEIGHT_ESTIMATE > window.innerHeight && rect.top > TOOLTIP_HEIGHT_ESTIMATE
      ? { bottom: `${window.innerHeight - rect.top + 8}px`, right }
      : { top: `${rect.bottom + 8}px`, right };
}

function cancelLeave(): void {
  if (leaveTimer !== undefined) clearTimeout(leaveTimer);
  leaveTimer = undefined;
}

function close(): void {
  cancelLeave();
  open.value = false;
}

// One decision from the four inputs: open while the pointer or focus is on the trigger or the
// tooltip. A pointer that leaves gets a moment to reach the tooltip; losing focus closes at once.
function update(grace: boolean): void {
  const active = hover.trigger || hover.tip || focus.trigger || focus.tip;
  if (active && !dismissed && props.recent.length > 0) {
    cancelLeave();
    if (!open.value) {
      place();
      open.value = true;
    }
    return;
  }
  if (!active) dismissed = false;
  if (!open.value) return;
  if (grace && !dismissed) {
    if (leaveTimer === undefined) leaveTimer = setTimeout(close, LEAVE_DELAY_MS);
  } else {
    close();
  }
}

function set(source: 'hover' | 'focus', part: 'trigger' | 'tip', value: boolean): void {
  (source === 'hover' ? hover : focus)[part] = value;
  if (value) dismissed = false;
  update(source === 'hover' && !value);
}

function onEscape(event: Event): void {
  if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || !open.value) return;
  // Close the tooltip only; the Escape must not also close a drawer behind it.
  event.stopPropagation();
  dismissed = true;
  close();
}

// While open: Escape from anywhere, and a scroll (the table or the page) or resize moves the
// anchor, so the tooltip follows it.
watch(open, (isOpen) => {
  const method = isOpen ? 'addEventListener' : 'removeEventListener';
  document[method]('keydown', onEscape, true);
  window[method]('scroll', place, true);
  window[method]('resize', place);
});

onBeforeUnmount(() => {
  cancelLeave();
  document.removeEventListener('keydown', onEscape, true);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
});
</script>

<template>
  <span class="cost">
    <template v-if="usd !== null && uzs !== null">
      <button
        ref="trigger"
        type="button"
        class="cost__usd num"
        :aria-describedby="open ? tooltipId : undefined"
        :aria-label="`${t('staffCost.cost.column')}: ${formatUsd(usd)}, ${formatUzsWithCurrency(uzs)}`"
        @mouseenter="set('hover', 'trigger', true)"
        @mouseleave="set('hover', 'trigger', false)"
        @focus="set('focus', 'trigger', true)"
        @blur="set('focus', 'trigger', false)"
      >
        {{ formatUsd(usd) }}
      </button>
      <!-- The so'm figure and its rate share one line: a price row stays two lines tall. -->
      <span class="cost__sub">
        <span class="cost__uzs num">{{ formatUzsWithCurrency(uzs) }}</span>
        <span
          v-if="deliveryRate !== null"
          class="cost__rate"
          :title="t('staffCost.cost.rateTip')"
          data-testid="cost-rate"
        >
          {{ t('staffCost.cost.atRate', { rate: formatRate(deliveryRate) }) }}
        </span>
      </span>
      <Teleport to="body">
        <div
          v-if="open"
          :id="tooltipId"
          class="tip"
          role="tooltip"
          :style="position"
          tabindex="-1"
          data-testid="cost-tooltip"
          @mouseenter="set('hover', 'tip', true)"
          @mouseleave="set('hover', 'tip', false)"
          @focusin="set('focus', 'tip', true)"
          @focusout="set('focus', 'tip', false)"
        >
          <p class="tip__title">
            {{ t('staffCost.cost.recentTitle', { count: recent.length }, recent.length) }}
          </p>
          <table class="tip__table">
            <thead>
              <tr>
                <th scope="col">{{ t('staffCost.supply.date') }}</th>
                <th scope="col">{{ t('staffCost.supply.deliveryId') }}</th>
                <th scope="col">{{ t('staffCost.supply.supplier') }}</th>
                <th scope="col" class="tip__num">{{ t('staffCost.supply.usd') }}</th>
                <th scope="col" class="tip__num">{{ t('staffCost.supply.rate') }}</th>
                <th scope="col" class="tip__num">{{ t('staffCost.supply.uzs') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="delivery in recent" :key="delivery.ref + delivery.date">
                <td>{{ formatDate(delivery.date) }}</td>
                <td class="mono">{{ delivery.ref }}</td>
                <td>{{ delivery.supplier }}</td>
                <td class="tip__num num">{{ formatUsd(delivery.usd) }}</td>
                <td class="tip__num num">{{ formatRate(delivery.rate) }}</td>
                <td class="tip__num num">{{ formatUzs(delivery.uzs) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Teleport>
    </template>
    <template v-else>
      <span class="cost__none" aria-hidden="true">—</span>
      <span class="sr-only">{{ t('staffCost.cost.none') }}</span>
    </template>
  </span>
</template>

<style scoped>
.cost {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}

.cost__usd {
  padding: 0;
  border: 0;
  border-bottom: 1px dotted var(--b5);
  background: none;
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
  cursor: help;
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.cost__usd:focus-visible {
  outline-color: var(--acc);
}

.cost__sub {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  line-height: 1.3;
  white-space: nowrap;
}

.cost__uzs {
  font-size: var(--fs-group);
  color: var(--t2);
}

.cost__rate {
  font-size: var(--fs-group);
  color: var(--t3);
}

.cost__none {
  color: var(--t3);
}

.tip {
  position: fixed;
  z-index: var(--z-popover);
  max-width: calc(100vw - 16px);
  padding: 12px 14px;
  overflow-x: auto;
  border: 1px solid var(--e8);
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: var(--sh-dropdown);
}

.tip__title {
  margin: 0 0 8px;
  font-size: var(--fs-small);
  font-weight: 600;
}

.tip__table {
  border-collapse: collapse;
  font-size: var(--fs-meta);
}

/* The v8 table header in miniature: 10px/500 uppercase grey labels over hairline-ruled rows. */
.tip__table th {
  padding: 2px 10px 6px 0;
  border-bottom: 1px solid var(--e8);
  text-align: left;
  font-size: var(--fs-group);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--t2);
  white-space: nowrap;
}

.tip__table td {
  padding: 5px 10px 5px 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tip__table .tip__num {
  text-align: right;
}
</style>
