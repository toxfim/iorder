<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '@core/composables/use-dialog-focus';
import StaffIcon from '@/components/ui/StaffIcon.vue';

// "Filtrlar" below 1024px (design «Filtrlar tugmasi bosildi», approved 2026-11-19): a sheet from
// the bottom (560px wide and centred on a tablet, full width on a phone). A list row unfolds its
// choices as chips under itself; the sort is chips too. Every choice applies at once, the bottom
// button only closes the sheet. The backdrop, Esc and the button close it and keep the choices.
export interface SheetChoice {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
}
export interface SheetList {
  readonly key: string;
  readonly label: string;
  /** Text of the current choice ("Hammasi" when none). */
  readonly current: string;
  readonly selected: string;
  readonly choices: readonly SheetChoice[];
}

const props = withDefaults(
  defineProps<{
    lists: readonly SheetList[];
    sorts: readonly SheetChoice[];
    sort: string;
    /** Products the current filters keep. */
    count: number;
    /** Chip groups always open above the lists (Narxlar: the ready views). */
    leadGroups?: readonly SheetList[];
    /** Chip groups always open between the lists and the sort (Narxlar: the currency). */
    tailGroups?: readonly SheetList[];
    /** The heading over the lists; Qoldiq's «Ro'yxatlar» when not given. */
    listsLabel?: string;
    /** Narxlar's rows point right («›», turning down when open); Qoldiq's point down. */
    chevronRight?: boolean;
  }>(),
  { leadGroups: () => [], tailGroups: () => [], listsLabel: undefined, chevronRight: false },
);
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{
  pick: [key: string, value: string];
  sort: [value: string];
  clear: [];
}>();

const { t } = useI18n();
const titleId = useId();
const panel = ref<HTMLElement | null>(null);
const unfolded = ref<string | null>(null);
const active = computed(() => open.value);
/** The sheet's sections in order: the open chip groups around the unfolding lists. */
const parts = computed(() => [
  ...props.leadGroups.map((group) => ({ key: `lead-${group.key}`, group })),
  { key: 'lists', group: null },
  ...props.tailGroups.map((group) => ({ key: `tail-${group.key}`, group })),
]);

watch(open, (value) => {
  if (value) unfolded.value = null;
});

function close(): void {
  open.value = false;
}

useDialogFocus({ active, container: panel, onEscape: close });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fsheet" data-testid="filter-sheet">
      <div class="fsheet__overlay" aria-hidden="true" @click="close" />
      <div
        ref="panel"
        class="fsheet__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <span class="fsheet__grip" aria-hidden="true" />
        <div class="fsheet__head">
          <h2 :id="titleId" class="fsheet__title">{{ t('staffCost.stock.sheet.title') }}</h2>
          <button type="button" class="fsheet__clear" @click="emit('clear')">
            {{ t('staffCost.stock.clearFilters') }}
          </button>
        </div>
        <div class="fsheet__body">
          <template v-for="part in parts" :key="part.key">
            <section
              v-if="part.group"
              class="fsheet__group fsheet__group--pad"
              :data-group="part.group.key"
            >
              <h3 class="fsheet__label">{{ part.group.label }}</h3>
              <div
                class="fsheet__chips fsheet__chips--flat"
                role="group"
                :aria-label="part.group.label"
              >
                <button
                  v-for="choice in part.group.choices"
                  :key="choice.value"
                  type="button"
                  class="fsheet__chip"
                  :class="{ 'fsheet__chip--on': choice.value === part.group.selected }"
                  :aria-pressed="choice.value === part.group.selected"
                  @click="emit('pick', part.group.key, choice.value)"
                >
                  {{ choice.label
                  }}<span v-if="choice.count !== undefined" class="fsheet__count num">{{
                    choice.count
                  }}</span>
                </button>
              </div>
            </section>
            <section v-else class="fsheet__group">
              <h3 class="fsheet__label fsheet__label--pad">
                {{ props.listsLabel ?? t('staffCost.stock.sheet.lists') }}
              </h3>
              <div v-for="list in props.lists" :key="list.key" class="fsheet__list">
                <button
                  type="button"
                  class="fsheet__row"
                  :aria-expanded="unfolded === list.key"
                  :data-list="list.key"
                  @click="unfolded = unfolded === list.key ? null : list.key"
                >
                  <span>{{ list.label }}</span>
                  <span class="fsheet__value"
                    >{{ list.current }}
                    <StaffIcon
                      name="down"
                      :size="14"
                      class="fsheet__chevron"
                      :class="{
                        'fsheet__chevron--open': unfolded === list.key,
                        'fsheet__chevron--right': props.chevronRight,
                      }"
                  /></span>
                </button>
                <div
                  v-if="unfolded === list.key"
                  class="fsheet__chips"
                  role="group"
                  :aria-label="list.label"
                >
                  <button
                    v-for="choice in list.choices"
                    :key="choice.value"
                    type="button"
                    class="fsheet__chip"
                    :class="{ 'fsheet__chip--on': choice.value === list.selected }"
                    :aria-pressed="choice.value === list.selected"
                    @click="emit('pick', list.key, choice.value)"
                  >
                    {{ choice.label
                    }}<span v-if="choice.count !== undefined" class="fsheet__count num">{{
                      choice.count
                    }}</span>
                  </button>
                </div>
              </div>
            </section>
          </template>
          <section class="fsheet__group fsheet__group--pad">
            <h3 class="fsheet__label">{{ t('staffCost.stock.sort.label') }}</h3>
            <div class="fsheet__chips fsheet__chips--flat" role="group">
              <button
                v-for="choice in props.sorts"
                :key="choice.value"
                type="button"
                class="fsheet__chip"
                :class="{ 'fsheet__chip--on': choice.value === props.sort }"
                :aria-pressed="choice.value === props.sort"
                @click="emit('sort', choice.value)"
              >
                {{ choice.label }}
              </button>
            </div>
          </section>
        </div>
        <div class="fsheet__foot">
          <button type="button" class="fsheet__show" data-testid="filter-sheet-show" @click="close">
            {{ t('staffCost.stock.sheet.show', { count: props.count }, props.count) }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fsheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
}

.fsheet__overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay-modal);
}

.fsheet__panel {
  position: absolute;
  top: calc(64px + var(--safe-top, 0px));
  bottom: 0;
  left: 50%;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  border-radius: 18px 18px 0 0;
  background: var(--w);
  color: var(--ink);
  transform: translateX(-50%);
}

.fsheet__panel:focus {
  outline: none;
}

.fsheet__grip {
  width: 40px;
  height: 4px;
  margin: 8px auto 4px;
  border-radius: 999px;
  background: var(--d9);
}

.fsheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px 12px;
}

.fsheet__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 700;
}

.fsheet__clear {
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--acc-fg);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  cursor: pointer;
}

.fsheet__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 20px;
  overflow: auto;
  padding-bottom: 16px;
}

.fsheet__group {
  display: flex;
  flex-direction: column;
}

.fsheet__group--pad {
  gap: 10px;
  padding: 0 16px;
}

.fsheet__label {
  margin: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t2);
}

.fsheet__label--pad {
  padding: 0 16px 8px;
}

.fsheet__list {
  border-top: 1px solid var(--ef);
}

.fsheet__list:last-child {
  border-bottom: 1px solid var(--ef);
}

.fsheet__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 52px;
  padding: 0 16px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body-lg);
  text-align: left;
  cursor: pointer;
}

.fsheet__value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body);
  color: var(--t2);
}

.fsheet__chevron {
  transition: transform 0.15s ease;
}

.fsheet__chevron--open {
  transform: rotate(180deg);
}

.fsheet__chevron--right {
  transform: rotate(-90deg);
}

.fsheet__chevron--right.fsheet__chevron--open {
  transform: none;
}

.fsheet__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 16px 16px;
}

.fsheet__chips--flat {
  padding: 0;
}

.fsheet__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--e8);
  border-radius: 999px;
  background: var(--w);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  cursor: pointer;
}

.fsheet__chip--on {
  border-color: var(--btn-ink-bg);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.fsheet__count {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fsheet__chip--on .fsheet__count {
  color: inherit;
}

.fsheet__row:focus-visible,
.fsheet__chip:focus-visible,
.fsheet__clear:focus-visible,
.fsheet__show:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.fsheet__foot {
  padding: 12px 16px calc(24px + var(--safe-bottom, 0px));
  border-top: 1px solid var(--ef);
}

.fsheet__show {
  width: 100%;
  height: 52px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--acc);
  color: var(--acc-on);
  font: inherit;
  font-size: var(--fs-body-lg);
  font-weight: 600;
  cursor: pointer;
}

.fsheet__show:hover {
  background: var(--acc-hover);
}
</style>
