<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCustomerServices } from '../services';

// Shown on every page while a company employee uses the customer app as a viewer
// ([C] 2026-11-09). What it says comes from the server's `/me` answer alone: whether an order can
// be placed here and, when it can, the organization the order is written to.
const { t } = useI18n();
const { session } = useCustomerServices();

const viewer = computed(() => session.staffViewer.value);
const text = computed(() => {
  const current = viewer.value;
  if (current === null) return '';
  return current.canOrder && current.organizationName !== null
    ? t('customer.viewer.noticeOrdering', { organization: current.organizationName })
    : t('customer.viewer.notice');
});
</script>

<template>
  <aside
    v-if="viewer !== null"
    class="viewer"
    role="note"
    :aria-label="t('customer.viewer.label')"
    data-testid="viewer-notice"
  >
    <p class="viewer__text">
      <strong class="viewer__label">{{ t('customer.viewer.label') }}</strong>
      <span>{{ text }}</span>
    </p>
  </aside>
</template>

<style scoped>
/* A thin, calm strip: always there, never in the way of the page under it. The shell stretches
   its children to fill the height (`.app__main > *`); the element selector outranks that rule, so
   the strip keeps its own height whatever the order of the stylesheets. */
aside.viewer {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--e8);
  border-radius: var(--r-input);
  background: var(--f5);
  color: var(--t3);
  font-size: var(--fs-meta);
  line-height: 1.4;
}

.viewer__text {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.viewer__label {
  color: var(--ink);
  font-weight: 600;
}
</style>
