<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import OrderAllocationsTable from './OrderAllocationsTable.vue';
import type { OrderPicking, ScanTarget } from '../composables/use-order-picking';
import {
  displayCode,
  lineViews,
  nextSlot,
  type LineView,
  type SlotView,
  type UnitView,
} from '../domain/picking-model';

// The warehouse's scanner screen ([C] 2026-10-25, reference-distributor experience), drawn as v8
// "Yig'ish va skanerlash": a table of the lines, the selected line below it with one unit at a
// time. A hardware scanner types the code and presses Enter; the cursor jumps to the next empty
// required slot by itself (IMEI 1, then the marking of the same unit, then the next unit, then
// the next line; the optional IMEI 2 is skipped but can be tapped). Manager, accountant and admin
// get the same view without fields. The server decides every scan; the shared validator only
// answers first. Quantity goods have no code and no picked-count endpoint, so they are listed
// read-only ("no codes needed").

const props = defineProps<{
  picking: OrderPicking;
  /** The warehouse's list of what to take from which supply; the money roles have it on the page. */
  showsSupplies?: boolean;
}>();

const { t } = useI18n();
const { formatNumber, formatTime, formatUnit } = useFormat();

const view = computed(() => props.picking.picking.value);
const state = computed(() => props.picking.state.value);
const editable = computed(() => view.value?.editable === true);
const lines = computed<LineView[]>(() => (view.value ? lineViews(view.value) : []));
const supplyLines = computed(() =>
  (view.value?.lines ?? []).map((line) => ({
    id: line.itemId,
    productCode: line.productCode,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    allocations: line.allocations,
    stockTracked: line.stockTracked,
  })),
);
const progress = computed(() => props.picking.progress.value);
const needsCodes = computed(() => progress.value.total > 0);
const rejected = computed(() => props.picking.rejected.value);
const pending = computed(() => props.picking.pending.value);

const slotLabel = (slot: Pick<SlotView, 'kind' | 'slot'>): string =>
  t(`orders.picking.slots.${slot.kind}_${slot.slot}`);
const unitLabel = (unitNo: number): string => t('orders.picking.unit', { no: unitNo });

// --- the lines table -----------------------------------------------------------------------

type RowState = 'READY' | 'PARTIAL' | 'WAITING' | 'NO_CODES';

const codeUnits = (line: LineView): readonly UnitView[] =>
  line.units.filter((unit) => unit.slots.some((slot) => slot.required));
const doneUnits = (line: LineView): number =>
  codeUnits(line).filter((unit) => unit.complete).length;

function rowState(line: LineView): RowState {
  const units = codeUnits(line);
  if (line.scanless || units.length === 0) return 'NO_CODES';
  const done = doneUnits(line);
  if (done === units.length) return 'READY';
  const started = units.some((unit) => unit.slots.some((slot) => slot.value !== null));
  return done > 0 || started ? 'PARTIAL' : 'WAITING';
}

/** Short tracking names for the chip: IMEI, SN, MK, or "pieces" for quantity goods. */
function kindsOf(line: LineView): string {
  if (line.scanless) return t('orders.picking.kindsShort.NONE');
  const kinds: string[] = [];
  if (line.line.trackingType !== 'NONE') {
    kinds.push(t(`orders.picking.kindsShort.${line.line.trackingType}`));
  }
  if (line.line.markingRequired) kinds.push(t('orders.picking.kindsShort.MARKING'));
  return kinds.join(' · ');
}

// --- selection: one line, one unit of it -----------------------------------------------------

const selectedItem = ref<string | null>(null);
const selectedUnit = ref<string | null>(null);

const selected = computed<LineView | null>(
  () => lines.value.find((line) => line.line.itemId === selectedItem.value) ?? null,
);
// The unit whose fields are open: the chosen one, else the first that still misses a code.
const currentUnit = computed<UnitView | null>(() => {
  const line = selected.value;
  if (!line || line.scanless) return null;
  return (
    line.units.find((unit) => unit.unitId === selectedUnit.value) ??
    line.units.find((unit) => !unit.complete) ??
    null
  );
});
const scannedUnits = computed(() =>
  (selected.value?.units ?? []).filter((unit) => unit.slots.some((slot) => slot.value !== null)),
);
const slotColumns = computed(() => selected.value?.units[0]?.slots ?? []);

/** Where every slot lives, so the cursor can open the right line and unit before it lands. */
const owners = computed(() => {
  const map = new Map<string, { itemId: string; unitId: string }>();
  for (const line of lines.value) {
    for (const unit of line.units) {
      for (const slot of unit.slots) {
        map.set(slot.key, { itemId: line.line.itemId, unitId: unit.unitId });
      }
    }
  }
  return map;
});

// --- fields and focus ----------------------------------------------------------------------

const drafts = reactive<Record<string, string>>({});
/** Filled slots the person opened to scan again (Rescan); Escape closes them. */
const rescanning = ref<ReadonlySet<string>>(new Set());
const inputs = new Map<string, HTMLInputElement>();

function bindInput(key: string) {
  return (element: unknown): void => {
    if (element instanceof HTMLInputElement) inputs.set(key, element);
    else inputs.delete(key);
  };
}

const showsInput = (slot: SlotView): boolean =>
  editable.value && (slot.value === null || rescanning.value.has(slot.key));
const shownSlots = (unit: UnitView): SlotView[] =>
  unit.slots.filter((slot) => slot.value !== null || slot.required || editable.value);

function setRescanning(key: string, open: boolean): void {
  const next = new Set(rescanning.value);
  if (open) next.add(key);
  else next.delete(key);
  rescanning.value = next;
}

async function focusSlot(key: string): Promise<void> {
  const owner = owners.value.get(key);
  if (owner) {
    selectedItem.value = owner.itemId;
    selectedUnit.value = owner.unitId;
  }
  await nextTick();
  const input = inputs.get(key);
  if (!input) return;
  input.focus();
  input.select();
}

/** The first empty slot of a unit, required ones first: where a tap on the unit puts the cursor. */
const firstEmpty = (unit: UnitView): SlotView | undefined =>
  unit.slots.find((slot) => slot.required && slot.value === null) ??
  unit.slots.find((slot) => slot.value === null);

function selectLine(line: LineView): void {
  selectedItem.value = line.line.itemId;
  selectedUnit.value = null;
  const unit = currentUnit.value;
  const slot = unit ? firstEmpty(unit) : undefined;
  if (editable.value && slot) void focusSlot(slot.key);
}

function selectUnit(unit: UnitView): void {
  selectedUnit.value = unit.unitId;
  const slot = firstEmpty(unit);
  if (editable.value && slot) void focusSlot(slot.key);
}

function targetOf(slot: SlotView, line: LineView): ScanTarget {
  return {
    unitId: slot.unitId,
    kind: slot.kind,
    slot: slot.slot,
    unitNo: slot.unitNo,
    productName: line.line.name,
  };
}

async function submit(slot: SlotView, line: LineView): Promise<void> {
  const raw = drafts[slot.key] ?? '';
  if (raw.trim() === '') return;
  drafts[slot.key] = '';
  const sent = props.picking.scan(targetOf(slot, line), raw);
  // The shared validator answered synchronously: a refused code keeps the cursor here for the
  // rescan; an accepted one moves on at once, so the next scan does not wait for the server.
  if (!pending.value.has(slot.key)) {
    void focusSlot(slot.key);
    await sent;
    return;
  }
  const current = props.picking.picking.value;
  const next = current ? nextSlot(current, slot.key, new Set([...pending.value])) : null;
  if (next) void focusSlot(next.key);
  const stored = await sent;
  if (stored) {
    setRescanning(slot.key, false);
    return;
  }
  // The server refused it: back to that slot, unless the person already started the next code.
  const moved = next ? (drafts[next.key] ?? '') === '' : true;
  if (moved) void focusSlot(slot.key);
}

function startRescan(slot: SlotView): void {
  setRescanning(slot.key, true);
  drafts[slot.key] = '';
  void focusSlot(slot.key);
}

function cancelRescan(slot: SlotView): void {
  if (!rescanning.value.has(slot.key)) return;
  setRescanning(slot.key, false);
  drafts[slot.key] = '';
}

async function clearSlot(slot: SlotView, line: LineView): Promise<void> {
  setRescanning(slot.key, false);
  if (await props.picking.clear(targetOf(slot, line))) void focusSlot(slot.key);
}

// The first time a view appears: the scanner's cursor waits in the first empty required slot;
// a read-only view opens the first line that has codes, so the codes are visible at once.
let openedOnce = false;
watch(
  [view, editable],
  ([current, canScan]) => {
    if (openedOnce || !current) return;
    openedOnce = true;
    const first = canScan ? nextSlot(current, null) : null;
    if (first) {
      void focusSlot(first.key);
      return;
    }
    const withCodes = lines.value.find((line) => !line.scanless);
    selectedItem.value = withCodes?.line.itemId ?? null;
  },
  { immediate: true },
);

// --- feedback ------------------------------------------------------------------------------

const flash = ref<{ slot: string; ok: boolean } | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.picking.feedback.value,
  (feedback) => {
    if (!feedback) return;
    flash.value = { slot: feedback.slot, ok: feedback.ok };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.value = null;
    }, 900);
  },
);
onBeforeUnmount(() => clearTimeout(flashTimer));

const flashOf = (key: string): 'ok' | 'error' | null =>
  flash.value?.slot === key ? (flash.value.ok ? 'ok' : 'error') : null;

/** The words for the latest result, read out by screen readers and shown under the table. */
const announcement = computed(() => {
  const feedback = props.picking.feedback.value;
  if (!feedback) return '';
  const where = `${feedback.target.productName} · ${unitLabel(feedback.target.unitNo)} · ${slotLabel(feedback.target)}`;
  if (feedback.ok) {
    return t(feedback.action === 'scan' ? 'orders.picking.saved' : 'orders.picking.cleared', {
      where,
    });
  }
  const reason = feedback.refusal
    ? t(feedback.refusal.key, { ...(feedback.refusal.params ?? {}) })
    : '';
  return t('orders.picking.refused', { where, reason });
});
const lastOk = computed(() => props.picking.feedback.value?.ok !== false);

const subtitle = computed<{ text: string; readOnly: boolean }>(() => {
  if (!view.value) return { text: '', readOnly: false };
  if (!needsCodes.value) return { text: t('orders.picking.nothingToScan'), readOnly: false };
  if (editable.value) return { text: t('orders.picking.scanHint'), readOnly: false };
  if (view.value.status === 'MANAGER_APPROVED' || view.value.status === 'ACCOUNTING_CLEARED') {
    return { text: t('orders.picking.readOnly'), readOnly: true };
  }
  return { text: t('orders.picking.archived'), readOnly: false };
});
</script>

<template>
  <section class="picking" :aria-label="t('orders.picking.title')" data-testid="picking-panel">
    <header class="picking__head">
      <div class="picking__heading">
        <h2 class="picking__title">{{ t('orders.picking.title') }}</h2>
        <span
          v-if="subtitle.text"
          class="picking__sub"
          :data-testid="subtitle.readOnly ? 'picking-read-only' : undefined"
          >{{ subtitle.text }}</span
        >
      </div>
      <span
        v-if="state === 'ready' && needsCodes"
        class="pill"
        :class="{ 'pill--done': view?.complete }"
        role="progressbar"
        :aria-valuemin="0"
        :aria-valuemax="progress.total"
        :aria-valuenow="progress.done"
        :aria-label="t('orders.picking.progressLabel')"
        data-testid="picking-progress"
      >
        {{ t('orders.picking.progress', progress) }}
      </span>
    </header>

    <p v-if="state === 'loading' || state === 'idle'" class="status" role="status">
      {{ t('state.loading') }}
    </p>
    <p v-else-if="state === 'denied'" class="status" role="alert">
      {{ t('orders.picking.denied') }}
    </p>
    <p v-else-if="state === 'notFound'" class="status" role="alert">
      {{ t('orders.errors.gone') }}
    </p>
    <p v-else-if="state === 'error'" class="status" role="alert">
      {{ t('orders.picking.loadError') }}
      <button type="button" class="link" @click="picking.load()">{{ t('state.retry') }}</button>
    </p>

    <template v-else-if="view">
      <OrderAllocationsTable
        v-if="showsSupplies"
        class="supplies"
        :lines="supplyLines"
        :status="view.status"
        :total="null"
      />
      <!-- The lines: a table on a wide screen, two-row cards on a phone (a sideways-scrolling
           table hides the status column right where the thumb is). -->
      <div class="rows">
        <div class="rows__head" aria-hidden="true">
          <span>{{ t('orders.picking.columns.no') }}</span>
          <span>{{ t('orders.picking.columns.product') }}</span>
          <span>{{ t('orders.picking.columns.kind') }}</span>
          <span class="rows__end">{{ t('orders.picking.columns.need') }}</span>
          <span class="rows__end">{{ t('orders.picking.columns.scanned') }}</span>
          <span>{{ t('orders.picking.columns.state') }}</span>
        </div>
        <button
          v-for="(line, index) in lines"
          :key="line.line.itemId"
          type="button"
          class="row"
          :class="{ 'row--on': line.line.itemId === selectedItem }"
          :aria-pressed="line.line.itemId === selectedItem"
          @click="selectLine(line)"
        >
          <span class="row__no">{{ index + 1 }}</span>
          <span class="row__name">
            <span class="row__title">{{ line.line.name }}</span>
            <span class="row__code">{{ line.line.productCode }}</span>
          </span>
          <span class="row__kind"
            ><span class="kind">{{ kindsOf(line) }}</span></span
          >
          <span class="row__need" :data-label="t('orders.picking.columns.need')">{{
            t('orders.picking.quantity', {
              quantity: formatNumber(line.line.quantity),
              unit: formatUnit(line.line.unit),
            })
          }}</span>
          <span
            class="row__done"
            :class="`row__done--${rowState(line)}`"
            :data-label="t('orders.picking.columns.scanned')"
            >{{
              rowState(line) === 'NO_CODES' ? '—' : `${doneUnits(line)}/${codeUnits(line).length}`
            }}</span
          >
          <span class="row__state"
            ><span class="state" :class="`state--${rowState(line)}`">{{
              t(`orders.picking.rowState.${rowState(line)}`)
            }}</span></span
          >
        </button>
      </div>

      <div class="detail">
        <p v-if="!selected" class="hint">
          <StaffIcon name="circlecheck" :size="15" />
          {{ t('orders.picking.selectFirst') }}
        </p>

        <div v-else-if="selected.scanless" class="sel">
          <b class="sel__name">{{ selected.line.name }}</b>
          <span class="sel__meta">{{
            t('orders.picking.countOnly', {
              quantity: formatNumber(selected.line.quantity),
              unit: formatUnit(selected.line.unit),
            })
          }}</span>
        </div>

        <template v-else>
          <div class="sel__top">
            <div class="sel">
              <b class="sel__name">{{ selected.line.name }}</b>
              <span class="sel__meta">{{
                t('orders.picking.lineProgress', {
                  kinds: kindsOf(selected),
                  done: doneUnits(selected),
                  total: codeUnits(selected).length,
                })
              }}</span>
            </div>
            <div class="chips" role="group" :aria-label="t('orders.picking.units')">
              <button
                v-for="unit in selected.units"
                :key="unit.unitId"
                type="button"
                class="unit-chip"
                :class="{
                  'unit-chip--on': unit.unitId === currentUnit?.unitId,
                  'unit-chip--done': unit.complete,
                }"
                :aria-pressed="unit.unitId === currentUnit?.unitId"
                @click="selectUnit(unit)"
              >
                {{ unitLabel(unit.unitNo) }}
              </button>
            </div>
          </div>

          <div
            v-if="currentUnit"
            class="unit"
            :class="{ 'unit--done': currentUnit.complete }"
            :data-unit="currentUnit.unitNo"
          >
            <span class="unit__no">
              {{ unitLabel(currentUnit.unitNo) }}
              <span v-if="currentUnit.complete" class="unit__ok">{{
                t('orders.picking.unitDone')
              }}</span>
            </span>
            <div class="slots">
              <div
                v-for="slot in shownSlots(currentUnit)"
                :key="slot.key"
                class="slot"
                :class="[
                  flashOf(slot.key) ? `slot--${flashOf(slot.key)}` : '',
                  { 'slot--optional': !slot.required, 'slot--busy': pending.has(slot.key) },
                ]"
                :data-slot="slot.key"
              >
                <label class="slot__label" :for="`picking-${slot.key}`">
                  {{ slotLabel(slot) }}
                </label>
                <div v-if="showsInput(slot)" class="slot__field">
                  <input
                    :id="`picking-${slot.key}`"
                    :ref="bindInput(slot.key)"
                    v-model="drafts[slot.key]"
                    class="slot__input"
                    type="text"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    enterkeyhint="next"
                    :placeholder="
                      slot.value ? displayCode(slot.value) : t('orders.picking.scanPlaceholder')
                    "
                    :aria-busy="pending.has(slot.key) || undefined"
                    :aria-label="`${selected.line.name} · ${unitLabel(currentUnit.unitNo)} · ${slotLabel(slot)}`"
                    @keydown.enter.prevent="submit(slot, selected)"
                    @keydown.esc="cancelRescan(slot)"
                  />
                  <button
                    v-if="rescanning.has(slot.key)"
                    type="button"
                    class="slot__cancel"
                    @click="cancelRescan(slot)"
                  >
                    {{ t('common.cancel') }}
                  </button>
                </div>
                <div v-else-if="slot.value !== null" class="slot__value">
                  <StaffIcon name="check" :size="14" :stroke-width="2" class="slot__check" />
                  <span class="slot__code">{{ displayCode(slot.value) }}</span>
                  <template v-if="editable">
                    <button
                      type="button"
                      class="slot__btn"
                      :disabled="pending.has(slot.key)"
                      :title="t('orders.picking.rescan')"
                      :aria-label="`${t('orders.picking.rescan')}: ${slotLabel(slot)} · ${unitLabel(currentUnit.unitNo)}`"
                      @click="startRescan(slot)"
                    >
                      <StaffIcon name="refresh" :size="13" />
                    </button>
                    <button
                      type="button"
                      class="slot__btn"
                      :disabled="pending.has(slot.key)"
                      :title="t('orders.picking.clear')"
                      :aria-label="`${t('orders.picking.clear')}: ${slotLabel(slot)} · ${unitLabel(currentUnit.unitNo)}`"
                      @click="clearSlot(slot, selected)"
                    >
                      <StaffIcon name="trash" :size="13" />
                    </button>
                  </template>
                </div>
                <span v-else class="slot__missing">{{ t('orders.picking.notScanned') }}</span>
              </div>
            </div>
          </div>
          <p v-else class="line-done">
            <StaffIcon name="circlecheck" :size="16" />
            {{ t('orders.picking.lineDone') }}
          </p>

          <div v-if="scannedUnits.length > 0" class="scanned" role="table">
            <div class="scanned__row scanned__row--head" role="row">
              <span class="scanned__unit" role="columnheader">{{
                t('orders.picking.unitColumn')
              }}</span>
              <span
                v-for="slot in slotColumns"
                :key="slot.key"
                class="scanned__cell"
                role="columnheader"
                >{{ slotLabel(slot) }}</span
              >
            </div>
            <div v-for="unit in scannedUnits" :key="unit.unitId" class="scanned__row" role="row">
              <span class="scanned__unit" role="cell">{{ unitLabel(unit.unitNo) }}</span>
              <span
                v-for="slot in unit.slots"
                :key="slot.key"
                class="scanned__cell scanned__code"
                role="cell"
                >{{ slot.value === null ? '—' : displayCode(slot.value) }}</span
              >
            </div>
          </div>
        </template>
      </div>

      <p
        class="announce"
        :class="{ 'announce--error': !lastOk, 'announce--empty': announcement === '' }"
        :role="lastOk ? 'status' : 'alert'"
        data-testid="picking-announce"
      >
        {{ announcement }}
      </p>

      <section
        v-if="rejected.length > 0"
        class="rejected"
        :aria-label="t('orders.picking.rejected.title')"
        data-testid="picking-rejected"
      >
        <div class="rejected__head">
          <h3 class="rejected__title">
            {{ t('orders.picking.rejected.title') }}
            <span class="rejected__count">{{ rejected.length }}</span>
          </h3>
          <button type="button" class="link" @click="picking.dismissRejected()">
            {{ t('orders.picking.rejected.dismiss') }}
          </button>
        </div>
        <ul class="rejected__list">
          <li v-for="entry in rejected" :key="entry.id" class="rejected__item">
            <span class="rejected__reason">
              {{ t(entry.refusal.key, { ...(entry.refusal.params ?? {}) }) }}
            </span>
            <span class="rejected__where">
              {{ formatTime(entry.at) }} · {{ entry.target.productName }} ·
              {{ unitLabel(entry.target.unitNo) }} · {{ slotLabel(entry.target) }}
            </span>
            <span class="rejected__value">{{ displayCode(entry.value) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="editable && view.complete && needsCodes" class="all-done" role="status">
        <StaffIcon name="circlecheck" :size="16" />
        {{ t('orders.picking.allDone') }}
      </p>
    </template>
  </section>
</template>

<style scoped>
/* v8 "Yig'ish va skanerlash": a white hairline card; the table runs edge to edge, the selected
   line opens in a grey panel under it. */
.picking {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.picking__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px;
}

.picking__heading {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.picking__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.picking__sub {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.pill {
  padding: 4px 8px;
  border-radius: var(--r-pill);
  background: var(--acc-bg);
  font-size: var(--fs-meta);
  font-weight: 600;
  white-space: nowrap;
  color: var(--acc-fg);
}

.pill--done {
  background: var(--green-bg);
  color: var(--green);
}

.status {
  margin: 0;
  padding: 0 20px 20px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.supplies {
  margin-bottom: 16px;
}

/* --- lines table ---------------------------------------------------------------------------- */

.rows {
  display: flex;
  flex-direction: column;
}

.rows__head,
.row {
  display: grid;
  grid-template-columns: 36px minmax(180px, 1fr) 80px 70px 100px 110px;
  gap: 12px;
  align-items: center;
  padding: 0 20px;
  border-top: 1px solid var(--e8);
}

.rows__head {
  height: 36px;
  background: var(--f5);
  font-size: var(--fs-group);
  font-weight: 600;
  color: var(--t2);
}

.rows__end {
  text-align: right;
}

.row {
  width: 100%;
  min-height: 52px;
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  background: var(--w);
  font: inherit;
  font-size: var(--fs-small);
  text-align: left;
  color: var(--ink);
  cursor: pointer;
}

.row:hover {
  background: var(--hov);
}

.row--on,
.row--on:hover {
  background: var(--acc-bg);
}

.row:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}

.row__no {
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.row__name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 0;
  overflow-wrap: anywhere;
}

.row__title {
  font-weight: 500;
}

.row__code,
.kind,
.slot__input,
.slot__code,
.scanned__code,
.rejected__value {
  font-family: var(--font-mono);
}

.row__code {
  font-size: var(--fs-group);
  color: var(--t2);
}

.kind {
  display: inline-flex;
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-group);
  font-weight: 600;
  white-space: nowrap;
}

.row__need,
.row__done {
  text-align: right;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.row__done--WAITING,
.row__done--NO_CODES {
  color: var(--t2);
}

.row__done--PARTIAL {
  color: var(--acc-fg);
}

.row__done--READY {
  color: var(--green);
}

.state {
  display: inline-flex;
  padding: 4px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-group);
  font-weight: 600;
  white-space: nowrap;
}

.state--WAITING,
.state--NO_CODES {
  background: var(--f5);
  color: var(--t2);
}

.state--PARTIAL {
  background: var(--acc-bg);
  color: var(--acc-fg);
}

.state--READY {
  background: var(--green-bg);
  color: var(--green);
}

/* --- the selected line ------------------------------------------------------------------------ */

.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border-top: 1px solid var(--e8);
  background: var(--f5);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-btn-sm);
  background: var(--acc-bg);
  font-size: var(--fs-small);
  color: var(--acc-fg);
}

.sel__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sel {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.sel__name {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.sel__meta {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.unit-chip {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--t2);
  cursor: pointer;
}

.unit-chip--done {
  background: var(--green-bg);
  color: var(--green);
}

.unit-chip--on {
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.unit {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.unit--done {
  box-shadow: inset 0 0 0 1px var(--green);
}

.unit__no {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-small);
  font-weight: 600;
}

.unit__ok {
  font-size: var(--fs-meta);
  color: var(--green);
}

.slots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

.slot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 2px;
  border-radius: var(--r-btn-sm);
  transition: background-color 0.2s var(--ease);
}

.slot--ok {
  background: var(--green-bg);
}

.slot--error {
  background: var(--red-bg);
  animation: shake 0.3s var(--ease);
}

.slot__label {
  font-size: var(--fs-group);
  color: var(--t2);
}

.slot__field {
  display: flex;
  gap: 6px;
}

.slot__input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  /* 16px keeps iOS from zooming into the field on a phone. */
  font-size: 16px;
  color: var(--ink);
}

.slot__input:focus {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--acc);
}

.slot--error .slot__input {
  box-shadow: inset 0 0 0 2px var(--red);
}

.slot--busy .slot__input {
  background: var(--f5);
}

.slot__cancel {
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}

.slot__value,
.slot__missing {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 5px 0 10px;
  border-radius: var(--r-btn-sm);
}

.slot__value {
  background: var(--green-bg);
}

.slot__check {
  color: var(--green);
}

.slot__code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot__btn {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--t2);
  cursor: pointer;
}

.slot__btn:hover:not(:disabled) {
  background: var(--w);
  color: var(--ink);
}

.slot__btn:disabled {
  cursor: default;
  color: var(--b5);
}

.slot__missing {
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-small);
  color: var(--t3);
}

.line-done,
.all-done {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--green);
}

.all-done {
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
}

.scanned {
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.scanned__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 34px;
  padding: 0 14px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-meta);
}

.scanned__row--head {
  min-height: 32px;
  border-top: 0;
  font-size: var(--fs-group);
  font-weight: 600;
  color: var(--t2);
}

.scanned__unit {
  flex: none;
  width: 56px;
  color: var(--t2);
}

.scanned__cell {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- feedback ---------------------------------------------------------------------------------- */

.announce {
  margin: 0;
  padding: 10px 20px;
  border-top: 1px solid var(--e8);
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--green);
  overflow-wrap: anywhere;
}

.announce--error {
  color: var(--red);
}

.announce--empty {
  padding: 0;
  border-top: 0;
}

.rejected {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 20px;
  border-top: 1px solid var(--e8);
}

.rejected__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rejected__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--red);
}

.rejected__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rejected__item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--fs-meta);
}

.rejected__reason {
  font-weight: 600;
  color: var(--red);
}

.rejected__where,
.rejected__value {
  color: var(--t2);
  overflow-wrap: anywhere;
}

.link {
  min-height: var(--tap-min);
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--acc-fg);
  cursor: pointer;
}

/* Phone: each line is a two-row card (number, name and status on top; the tracking chip with
   needed / scanned under the name), so nothing scrolls sideways while scanning. */
@media (max-width: 639px) {
  .picking__head,
  .detail {
    padding: 16px;
  }

  .rows__head {
    display: none;
  }

  .row {
    grid-template-columns: 22px auto auto minmax(0, 1fr) auto;
    gap: 4px 10px;
    padding: 10px 16px;
  }

  .row__no {
    grid-area: 1 / 1;
    align-self: start;
    padding-top: 6px;
  }

  .row__name {
    grid-area: 1 / 2 / 2 / 5;
    padding: 4px 0 0;
  }

  .row__state {
    grid-area: 1 / 5;
    align-self: start;
    padding-top: 4px;
  }

  .row__kind,
  .row__need,
  .row__done {
    grid-row: 2;
    text-align: left;
    font-size: var(--fs-meta);
  }

  .row__kind {
    grid-column: 2;
  }

  .row__need {
    grid-column: 3;
  }

  .row__done {
    grid-column: 4;
  }

  .row__need::before,
  .row__done::before {
    content: attr(data-label) ' ';
    font-weight: 400;
    color: var(--t2);
  }

  .slots {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (pointer: coarse), (hover: none) {
  .unit-chip,
  .slot__btn {
    min-width: 44px;
    min-height: 44px;
  }

  .slot__input {
    height: 48px;
  }

  /* A filled or empty slot is as tall as the input it replaces, so its 44px buttons stay inside
     the row and the three states line up. */
  .slot__value,
  .slot__missing {
    height: 48px;
  }
}

@keyframes shake {
  25% {
    transform: translateX(-3px);
  }
  75% {
    transform: translateX(3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .slot--error {
    animation: none;
  }
}
</style>
