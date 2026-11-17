<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ViewState } from '@core/composables/use-async-view';
import { appOutdated, reloadPage } from '@core/lib/app-outdated';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';

// `ready` renders the default slot. `success` is a terminal confirmation screen (for example
// "order sent") and has no default copy: the caller supplies title/description.
export type StateViewState = ViewState | 'success';

const props = withDefaults(
  defineProps<{
    state: StateViewState;
    /** Overrides the default copy of empty/error/denied or supplies it for success. */
    title?: string;
    description?: string;
  }>(),
  { title: undefined, description: undefined },
);

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();

// Only the generic error copy changes; caller-supplied title/description always win.
const outdated = computed(() => props.state === 'error' && appOutdated.value);

const heading = computed(() => {
  if (props.title !== undefined) return props.title;
  if (outdated.value) return t('state.outdated.title');
  switch (props.state) {
    case 'empty':
      return t('state.empty.title');
    case 'error':
      return t('state.error.title');
    case 'denied':
      return t('state.denied.title');
    default:
      return undefined;
  }
});

const body = computed(() => {
  if (props.description !== undefined) return props.description;
  if (outdated.value) return t('state.outdated.description');
  switch (props.state) {
    case 'empty':
      return t('state.empty.description');
    case 'error':
      return t('state.error.description');
    case 'denied':
      return t('state.denied.description');
    default:
      return undefined;
  }
});

// Skeleton row widths, as in the prototype's loading state.
const SKELETON_ROWS = ['62%', '48%', '70%', '54%'] as const;
</script>

<template>
  <slot v-if="state === 'ready'" />
  <div
    v-else-if="state === 'loading'"
    class="loading"
    role="status"
    aria-busy="true"
    data-state="loading"
  >
    <div class="loading__sheet" aria-hidden="true">
      <span class="loading__title" />
      <span class="loading__subtitle" />
      <div class="loading__list">
        <div v-for="(width, index) in SKELETON_ROWS" :key="index" class="loading__row">
          <div class="loading__lines">
            <span class="loading__line" :style="{ width }" />
            <span class="loading__line loading__line--short" />
          </div>
          <span class="loading__action" />
        </div>
      </div>
    </div>
    <p class="loading__text">{{ t('state.loading') }}</p>
  </div>
  <div
    v-else
    class="state"
    :class="`state--${state}`"
    :role="state === 'error' || state === 'denied' ? 'alert' : 'status'"
    :data-state="state"
  >
    <span class="state__tile" aria-hidden="true">
      <AppIcon v-if="state === 'empty'" name="inbox" :size="26" :stroke-width="1.8" />
      <AppIcon v-else-if="state === 'denied'" name="lock" :size="24" />
      <AppIcon v-else-if="state === 'success'" name="check" :size="24" :stroke-width="3" />
      <!-- The design marks errors with a bold exclamation mark, not an icon. -->
      <span v-else class="state__bang">!</span>
    </span>

    <p v-if="heading" class="state__title">{{ heading }}</p>
    <p v-if="body" class="state__description">{{ body }}</p>

    <AppButton v-if="outdated" variant="dark" size="lg" @click="reloadPage()">
      {{ t('state.reload') }}
    </AppButton>
    <AppButton v-else-if="state === 'error'" variant="dark" size="lg" @click="emit('retry')">
      {{ t('state.retry') }}
    </AppButton>
    <div v-if="$slots.actions" class="state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  margin: 64px auto;
  text-align: center;
  animation: viewIn 0.35s var(--ease) both;
}

.state__tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--r-panel);
  background: var(--ef);
  color: var(--t2);
}

.state--error .state__tile {
  background: var(--red-bg);
  color: var(--red);
}

.state--denied .state__tile {
  background: var(--hero-bg);
  color: var(--hero-fg);
}

.state--success .state__tile {
  background: var(--green-bg);
  color: var(--green);
}

.state__bang {
  font-size: 26px;
  font-weight: 700;
}

.state__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.state__description {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t3);
}

.state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
}

.state :deep(.btn--dark) {
  margin-top: 8px;
}

/* Loading: skeleton of a titled list, then the caption (prototype loading state). */
.loading {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
}

.loading__sheet {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.loading__title {
  width: 220px;
  max-width: 70%;
  height: 28px;
  border-radius: var(--r-pill);
  background: var(--e8);
}

.loading__subtitle {
  width: 140px;
  height: 14px;
  border-radius: var(--r-kbd);
  background: var(--ef);
}

.loading__list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-row);
  padding: var(--container-pad);
  border-radius: var(--r-card);
  background: var(--ef);
}

.loading__row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: var(--r-row);
  background: var(--w);
}

.loading__lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.loading__line {
  height: 14px;
  border-radius: var(--r-kbd);
  background: var(--e8);
}

.loading__line--short {
  width: 90px;
  height: 10px;
  background: var(--ef);
}

.loading__action {
  width: 96px;
  height: 36px;
  border-radius: var(--r-btn-sm);
  background: var(--ef);
}

.loading__text {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
  text-align: center;
}
/* Staff design v8: quieter states (15px/600 title, 12px secondary text, 10px icon tile) and a
   loading skeleton shaped like the white hairline card with ruled rows. */
/* Auto margins centre the state in a growing flex column (a page that shows only a state); in a
   container that does not grow they resolve to 0 and the padding keeps the 64px offset. */
:root[data-staff-app] .state {
  margin: auto;
  padding: 64px 0;
}
:root[data-staff-app] .state__tile {
  width: 48px;
  height: 48px;
  border-radius: var(--r-row);
}
:root[data-staff-app] .state__title {
  font-size: var(--fs-section);
  font-weight: 600;
}
:root[data-staff-app] .state__description {
  font-size: var(--fs-small);
  color: var(--t2);
}
:root[data-staff-app] .loading__list {
  gap: 0;
  padding: 0;
  overflow: hidden;
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}
:root[data-staff-app] .loading__row {
  padding: 14px 20px;
  border-radius: 0;
  background: transparent;
}
:root[data-staff-app] .loading__row + .loading__row {
  border-top: 1px solid var(--e8);
}
:root[data-staff-app] .loading__line {
  background: var(--ef);
}
:root[data-staff-app] .loading__line--short,
:root[data-staff-app] .loading__subtitle,
:root[data-staff-app] .loading__action {
  background: var(--f5);
}
</style>
