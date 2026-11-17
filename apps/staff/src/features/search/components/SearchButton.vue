<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';

const { t } = useI18n();
const { commandPalette } = useServices();

// The hint names the key people actually press: Cmd on Apple keyboards, Ctrl elsewhere. The
// shortcut itself accepts both (StaffShell).
const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
// Key caps, not words: the same in every language.
const MODIFIER = isApple ? '⌘' : 'Ctrl';
</script>

<template>
  <!-- v8 top bar search: a field-looking button that opens the palette, with the shortcut hint. -->
  <button
    type="button"
    class="search"
    aria-haspopup="dialog"
    aria-keyshortcuts="Control+K Meta+K"
    @click="commandPalette.open()"
  >
    <StaffIcon name="search" :size="14" class="search__icon" />
    <span class="search__text">{{ t('search.button') }}</span>
    <span class="search__keys" aria-hidden="true">
      <kbd>{{ MODIFIER }}</kbd>
      <kbd>{{ 'K' }}</kbd>
    </span>
  </button>
</template>

<style scoped>
.search {
  display: flex;
  flex: 0 1 252px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--t2);
  text-align: left;
  cursor: text;
}

.search:hover {
  box-shadow: inset 0 0 0 1px var(--t3);
}

.search:focus-visible {
  outline: 0;
  box-shadow:
    inset 0 0 0 1px var(--acc),
    var(--ring-focus);
}

.search__icon {
  color: var(--t2);
}

.search__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  color: var(--t3);
}

/* v8 prints the shortcut as plain small text, not as key caps. */
.search__keys {
  display: flex;
  gap: 3px;
}

.search__keys kbd {
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: var(--fs-group);
  font-weight: 400;
  color: var(--t3);
}

@media (pointer: coarse) {
  .search {
    min-height: 44px;
  }

  /* No keyboard on phones: the shortcut hint would only take room. */
  .search__keys {
    display: none;
  }
}
</style>
