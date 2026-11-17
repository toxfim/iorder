<script setup lang="ts">
import type { BrandResponse } from '@iorder/shared/staff-cost';
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from 'vue';
import { useI18n } from 'vue-i18n';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { openDropdownId } from '@core/composables/use-open-dropdown';
import { brandOptions } from '../domain/brand-options';

// A searchable brand picker for one product: the text field is the combobox (WAI-ARIA 1.2
// "list autocomplete"), the brands are its listbox, and a typed name that matches no brand adds a
// "create" option at the end. Focus stays in the field; arrows move aria-activedescendant. The
// list is teleported and fixed, so the table's horizontal scroller cannot clip it.
const props = withDefaults(
  defineProps<{
    brands: readonly BrandResponse[];
    /** Accessible name of the field (the product it is for). */
    label: string;
    /** The choice is being saved: the field locks and says so. */
    busy?: boolean;
  }>(),
  { busy: false },
);
const emit = defineEmits<{ pick: [brand: BrandResponse]; create: [name: string] }>();

const { t } = useI18n();
const baseId = useId();
const listId = `${baseId}-list`;
const optionId = (index: number): string => `${baseId}-opt-${index}`;

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const query = ref('');
const active = ref(0);
const open = computed(() => openDropdownId.value === baseId);

type Choice =
  | { readonly kind: 'brand'; readonly brand: BrandResponse }
  | { readonly kind: 'create'; readonly name: string };

const options = computed(() => brandOptions(props.brands, query.value));
const choices = computed<Choice[]>(() => [
  ...options.value.matches.map((brand) => ({ kind: 'brand' as const, brand })),
  ...(options.value.createName === null
    ? []
    : [{ kind: 'create' as const, name: options.value.createName }]),
]);

watch(query, () => {
  active.value = 0;
});

// --- placement (fixed, under the field) ---------------------------------------------------------

const popStyle = ref<CSSProperties>({});
function place(): void {
  const rect = input.value?.getBoundingClientRect();
  if (!rect) return;
  const below = window.innerHeight - rect.bottom;
  // Opens upwards when the field is near the bottom of the screen (a phone keyboard is up).
  const up = below < 240 && rect.top > below;
  popStyle.value = {
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 240)}px`,
    ...(up
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` }),
  };
}

function scrollActiveIntoView(): void {
  const element = list.value ? document.getElementById(optionId(active.value)) : null;
  element?.scrollIntoView?.({ block: 'nearest' });
}

function openList(): void {
  if (props.busy) return;
  openDropdownId.value = baseId;
}

function closeList(): void {
  if (openDropdownId.value === baseId) openDropdownId.value = null;
}

watch(open, (isOpen) => {
  if (isOpen) {
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', onDocumentPress);
  } else {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('pointerdown', onDocumentPress);
  }
});

function onDocumentPress(event: Event): void {
  const target = event.target;
  if (target instanceof Node && (input.value?.contains(target) || list.value?.contains(target))) {
    return;
  }
  closeList();
}

onBeforeUnmount(() => {
  closeList();
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  document.removeEventListener('pointerdown', onDocumentPress);
});

// --- choosing ----------------------------------------------------------------------------------

function choose(choice: Choice): void {
  closeList();
  if (choice.kind === 'brand') emit('pick', choice.brand);
  else emit('create', choice.name);
}

function move(step: number): void {
  if (!open.value) {
    openList();
    return;
  }
  const total = choices.value.length;
  if (total === 0) return;
  active.value = Math.min(total - 1, Math.max(0, active.value + step));
  void nextTick(scrollActiveIntoView);
}

function onInput(): void {
  openList();
  if (open.value) place();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      if (!open.value) return;
      event.preventDefault();
      const choice = choices.value[active.value];
      if (choice) choose(choice);
      break;
    }
    case 'Escape':
      if (open.value) {
        // Dialog and page shortcuts see an open list's Esc as the list's.
        event.preventDefault();
        event.stopPropagation();
        closeList();
      } else if (query.value !== '') {
        event.preventDefault();
        query.value = '';
      }
      break;
    case 'Tab':
      closeList();
      break;
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="bcb" :class="{ 'bcb--open': open, 'bcb--busy': busy }">
    <StaffIcon name="search" :size="13" class="bcb__icon" />
    <input
      ref="input"
      v-model="query"
      class="bcb__input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && choices.length > 0 ? optionId(active) : undefined"
      :aria-label="label"
      :aria-busy="busy || undefined"
      :placeholder="busy ? t('brands.picker.saving') : t('brands.picker.placeholder')"
      :disabled="busy"
      :maxlength="120"
      @focus="openList"
      @click="openList"
      @input="onInput"
      @keydown="onKeydown"
    />
    <StaffIcon name="down" :size="13" class="bcb__chevron" />

    <Teleport to="body">
      <!-- mousedown.prevent keeps focus in the field while an option is clicked. -->
      <div
        v-show="open"
        ref="list"
        class="bcb__pop"
        :style="popStyle"
        data-testid="brand-options"
        @mousedown.prevent
      >
        <ul :id="listId" class="bcb__list" role="listbox" :aria-label="label">
          <li
            v-for="(choice, index) in choices"
            :id="optionId(index)"
            :key="choice.kind === 'brand' ? choice.brand.id : `create:${choice.name}`"
            role="option"
            class="bcb__option"
            :class="{
              'bcb__option--active': index === active,
              'bcb__option--create': choice.kind === 'create',
            }"
            :aria-selected="index === active"
            @click="choose(choice)"
            @mousemove="active = index"
          >
            <template v-if="choice.kind === 'brand'">
              <span class="bcb__label">{{ choice.brand.name }}</span>
            </template>
            <template v-else>
              <StaffIcon name="plus" :size="14" class="bcb__plus" />
              <span class="bcb__label">{{ t('brands.picker.create', { name: choice.name }) }}</span>
            </template>
          </li>
        </ul>
        <p v-if="choices.length === 0" class="bcb__none" role="status">
          {{ brands.length === 0 ? t('brands.picker.noBrands') : t('brands.picker.noMatch') }}
        </p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* v8 field: 38px white with a hairline ring; the open field gets the accent ring. */
.bcb {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.bcb:hover {
  box-shadow: inset 0 0 0 1px var(--t3);
}

.bcb--open,
.bcb:focus-within {
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.bcb--busy {
  background: var(--f5);
}

.bcb__icon,
.bcb__chevron {
  flex: none;
  color: var(--t2);
}

.bcb__chevron {
  transition: transform 0.2s ease;
}

.bcb--open .bcb__chevron {
  transform: rotate(180deg);
}

.bcb__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  /* 16px on phones keeps iOS from zooming into the field (see the media query). */
  font-size: var(--fs-small);
}

.bcb__input::placeholder {
  color: var(--t3);
}

.bcb__pop {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  border-radius: var(--r-row);
  background: var(--w);
  box-shadow:
    0 0 0 1px var(--e8),
    var(--sh-dropdown);
}

.bcb__list {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
}

.bcb__list:empty {
  display: none;
}

.bcb__option {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  color: var(--ink);
  font-size: var(--fs-small);
  cursor: pointer;
}

.bcb__option--active {
  background: var(--hov);
}

.bcb__option--create {
  color: var(--acc-fg);
  font-weight: 600;
}

.bcb__plus {
  flex: none;
}

.bcb__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bcb__none {
  margin: 0;
  padding: 14px 12px;
  font-size: var(--fs-small);
  color: var(--t2);
  text-align: center;
}

@media (max-width: 639px) {
  .bcb__input {
    font-size: 16px;
  }
}

@media (pointer: coarse), (hover: none) {
  .bcb {
    min-height: 44px;
  }

  .bcb__option {
    min-height: 44px;
  }
}
</style>
