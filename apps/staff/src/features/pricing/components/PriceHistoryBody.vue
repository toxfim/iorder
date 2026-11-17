<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppCard from '@/components/ui/AppCard.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import { describePricingError } from '@core/lib/price-errors';
import { useListPriceFormat } from '../composables/use-list-price-format';
import { translateDescribed } from '../domain/translate-error';
import PersonName from '@/features/people/components/PersonName.vue';

const props = defineProps<{ productId: string }>();

const { t } = useI18n();
const { pricingApi } = useServices();
const { formatDateTime } = useFormat();
const { listPrice } = useListPriceFormat();

// Mounted by the drawer only while it is open, so every opening reads fresh history.
const view = useAsyncView(() => pricingApi.getPriceHistory(props.productId), {
  isEmpty: (history) => history.entries.length === 0,
});

// The api lists oldest first; people want the latest change on top.
const entries = computed(() =>
  [...(view.data.value?.entries ?? [])].sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.versionNumber - a.versionNumber,
  ),
);

const errorText = computed(() =>
  translateDescribed(t, describePricingError('history', view.error.value)),
);
</script>

<template>
  <StateView
    :state="view.state.value"
    :description="view.state.value === 'error' ? errorText : undefined"
    :title="view.state.value === 'empty' ? t('prices.history.empty') : undefined"
    @retry="view.reload"
  >
    <!-- The design's "Narxlar tarixi" table. Its "Sabab" (reason) column has no counterpart: a
         price changes only by publishing a version, so the version number stands in its place. -->
    <AppCard :title="t('prices.history.heading')">
      <div class="scroll">
        <table class="hist">
          <thead>
            <tr>
              <th scope="col">{{ t('prices.history.columns.when') }}</th>
              <th scope="col">{{ t('prices.history.columns.change') }}</th>
              <th scope="col">{{ t('prices.history.columns.author') }}</th>
              <th scope="col" class="hist__end">{{ t('prices.history.columns.version') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, index) in entries"
              :key="entry.versionId"
              class="hist__row"
              :style="{ animationDelay: `${Math.min(index, 12) * 25}ms` }"
            >
              <td class="num hist__when">{{ formatDateTime(entry.publishedAt) }}</td>
              <td>
                <span class="change num">
                  <template v-if="entry.oldPrice !== null">
                    <s class="change__old">{{ listPrice(entry.oldPrice, entry.oldCurrency) }}</s>
                    <span aria-hidden="true">→</span>
                  </template>
                  <b v-if="entry.newPrice !== null">{{
                    listPrice(entry.newPrice, entry.currency)
                  }}</b>
                  <span v-else class="change__removed">{{ t('prices.history.removed') }}</span>
                </span>
                <span v-if="entry.oldPrice === null && entry.newPrice !== null" class="note">
                  {{ t('prices.history.added') }}
                </span>
                <span
                  v-if="entry.oldDeferredPrice !== null || entry.newDeferredPrice !== null"
                  class="note num"
                  data-deferred-change
                >
                  {{ t('prices.dialog.deferredShort') }}:
                  {{
                    entry.oldDeferredPrice !== null
                      ? listPrice(entry.oldDeferredPrice, entry.oldCurrency)
                      : '—'
                  }}
                  →
                  {{
                    entry.newDeferredPrice !== null
                      ? listPrice(entry.newDeferredPrice, entry.currency)
                      : '—'
                  }}
                </span>
                <span
                  v-if="entry.oldRrp !== null || entry.newRrp !== null"
                  class="note num"
                  data-rrp-change
                >
                  {{ t('prices.dialog.rrpShort') }}:
                  {{ entry.oldRrp !== null ? listPrice(entry.oldRrp, entry.oldCurrency) : '—' }}
                  →
                  {{ entry.newRrp !== null ? listPrice(entry.newRrp, entry.currency) : '—' }}
                </span>
              </td>
              <td class="hist__who">
                <PersonName
                  v-if="entry.publishedBy"
                  :name="entry.publishedBy"
                  :user-id="entry.publishedByUserId"
                />
                <template v-else>—</template>
              </td>
              <td class="hist__end">
                <span class="mono version">{{ `v${entry.versionNumber}` }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AppCard>
  </StateView>
</template>

<style scoped>
/* A narrow drawer (a phone) scrolls the table sideways inside the card, never the page. */
.scroll {
  overflow-x: auto;
}

.hist {
  width: 100%;
  min-width: 460px;
  border-collapse: collapse;
  font-size: var(--fs-small);
}

.hist th {
  height: 40px;
  padding: 0 8px;
  border-top: 1px solid var(--e8);
  border-bottom: 1px solid var(--e8);
  background: var(--f5);
  font-size: var(--fs-group);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--t2);
}

.hist td {
  height: 42px;
  padding: 8px;
  vertical-align: middle;
}

.hist th:first-child,
.hist td:first-child {
  padding-left: 20px;
}

.hist th:last-child,
.hist td:last-child {
  padding-right: 20px;
}

.hist__row {
  animation: rowIn 0.3s ease both;
}

.hist__row + .hist__row td {
  border-top: 1px solid var(--e8);
}

.hist__when {
  white-space: nowrap;
}

.hist__who {
  overflow-wrap: anywhere;
}

.hist .hist__end {
  text-align: right;
}

.change {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.change b {
  font-weight: 600;
}

.change__old {
  color: var(--t3);
}

.change__removed {
  font-weight: 600;
  color: var(--red);
}

.note {
  display: block;
  font-size: var(--fs-group);
  color: var(--t2);
}

.version {
  font-size: var(--fs-group);
  color: var(--t3);
}
</style>
