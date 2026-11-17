<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PriceTier } from '@iorder/shared';
import type { PriceListPostRecipientsResponse } from '@iorder/shared/staff-cost';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import { showToast } from '@core/composables/use-toast';
import { describePricingError } from '@core/lib/price-errors';
import { saveFile } from '@core/lib/save-file';
import { fallbackPriceFileName } from '../domain/price-file-name';
import { translateDescribed } from '../domain/translate-error';
import ChipMenu, { type ChipMenuItem } from './ChipMenu.vue';

// The Narxlar file actions (owner request, 2026-10-28; tiers [C, owner 2026-11-11]): "Excel
// yuklab olish" saves the file of the chosen price tier (every role that opens this page), the
// post sends each organization the file of its own tier now (manager and admin), after a confirm
// that counts who gets it. UI convenience only: the server enforces both.
const props = defineProps<{ canPost: boolean }>();

const { t } = useI18n();
const { priceListShareApi, clock } = useServices();

const errorText = (caught: unknown): string =>
  translateDescribed(t, describePricingError('brand', caught));

// --- download ----------------------------------------------------------------------------------

const downloading = ref(false);
const tierItems = computed<ChipMenuItem<PriceTier>[]>(() => [
  {
    id: 'STANDARD',
    icon: 'sheet',
    title: t('prices.tiers.STANDARD'),
    hint: t('prices.file.downloadStandardHint'),
    testId: 'download-excel-STANDARD',
  },
  {
    id: 'WHOLESALE_PARTNER',
    icon: 'sheet',
    title: t('prices.tiers.WHOLESALE_PARTNER'),
    hint: t('prices.file.downloadWholesaleHint'),
    testId: 'download-excel-WHOLESALE_PARTNER',
  },
  {
    id: 'ALIF_FACTORING',
    icon: 'sheet',
    title: t('prices.tiers.ALIF_FACTORING'),
    hint: t('prices.file.downloadAlifHint'),
    testId: 'download-excel-ALIF_FACTORING',
  },
]);

async function download(tier: PriceTier): Promise<void> {
  if (downloading.value) return;
  downloading.value = true;
  try {
    const file = await priceListShareApi.downloadExcel(tier);
    const name = file.fileName ?? fallbackPriceFileName(clock.now());
    saveFile(file.blob, name);
    showToast({ message: t('prices.file.downloaded', { name }) });
  } catch (caught) {
    showToast({ message: errorText(caught) });
  } finally {
    downloading.value = false;
  }
}

// --- post to the chats -------------------------------------------------------------------------

const confirmOpen = ref(false);
const posting = ref(false);
const postError = ref<string | null>(null);
const recipients = shallowRef<PriceListPostRecipientsResponse | null>(null);
const recipientsState = ref<'loading' | 'ready' | 'error'>('loading');
let recipientsRun = 0;

async function loadRecipients(): Promise<void> {
  const mine = ++recipientsRun;
  recipients.value = null;
  recipientsState.value = 'loading';
  try {
    const answer = await priceListShareApi.recipients();
    if (mine !== recipientsRun) return;
    recipients.value = answer;
    recipientsState.value = 'ready';
  } catch {
    // The counts only inform: the post itself still works and reports its own outcome.
    if (mine === recipientsRun) recipientsState.value = 'error';
  }
}

function askPost(): void {
  postError.value = null;
  confirmOpen.value = true;
  void loadRecipients();
}

const confirmLabel = computed(() =>
  recipients.value
    ? t('prices.file.postConfirmCount', { count: recipients.value.recipients.total })
    : t('prices.file.postConfirm'),
);
const skippedTotal = computed(() => {
  const skipped = recipients.value?.skipped;
  return skipped ? skipped.unbound + skipped.inactive + skipped.postingOff + skipped.noPrices : 0;
});

async function post(): Promise<void> {
  posting.value = true;
  postError.value = null;
  try {
    const answer = await priceListShareApi.postToGroups();
    confirmOpen.value = false;
    showToast({
      message:
        answer.recipients.total === 0
          ? t('prices.file.postedNone')
          : t('prices.file.posted', {
              number: answer.versionNumber,
              count: answer.recipients.total,
            }),
    });
  } catch (caught) {
    // The dialog stays open with the reason, so the person can retry or cancel.
    postError.value = errorText(caught);
  } finally {
    posting.value = false;
  }
}
</script>

<template>
  <ChipMenu
    :label="t('prices.file.download')"
    icon="download"
    :menu-label="t('prices.file.downloadMenu')"
    :items="tierItems"
    test-id="download-excel"
    :busy="downloading"
    @choose="download"
  />
  <button
    v-if="props.canPost"
    type="button"
    class="chip"
    data-testid="post-to-groups"
    @click="askPost"
  >
    <StaffIcon name="send" :size="16" class="chip__icon" />
    {{ t('prices.file.post') }}
  </button>

  <AppConfirmDialog
    v-if="props.canPost"
    v-model="confirmOpen"
    :title="t('prices.file.postTitle')"
    :description="t('prices.file.postDescription')"
    :confirm-label="confirmLabel"
    :loading="posting"
    :error="postError"
    @confirm="post"
  >
    <div class="recipients" data-testid="post-recipients">
      <p v-if="recipientsState === 'loading'" class="recipients__note" role="status">
        {{ t('prices.file.recipientsLoading') }}
      </p>
      <p v-else-if="recipientsState === 'error'" class="recipients__note" role="status">
        {{ t('prices.file.recipientsFailed') }}
      </p>
      <template v-else-if="recipients">
        <!-- The api counts by tier and by chat kind separately (not their combinations). -->
        <div class="recipients__group">
          <p class="recipients__head">{{ t('prices.file.byTier') }}</p>
          <dl class="recipients__list">
            <div class="recipients__row" data-testid="recipients-STANDARD">
              <dt class="recipients__label">
                <span class="recipients__dot" aria-hidden="true" />{{ t('prices.tiers.STANDARD') }}
              </dt>
              <dd class="recipients__count num">{{ recipients.recipients.byTier.STANDARD }}</dd>
            </div>
            <div class="recipients__row" data-testid="recipients-WHOLESALE_PARTNER">
              <dt class="recipients__label">
                <span class="recipients__dot recipients__dot--acc" aria-hidden="true" />{{
                  t('prices.tiers.WHOLESALE_PARTNER')
                }}
              </dt>
              <dd class="recipients__count num">
                {{ recipients.recipients.byTier.WHOLESALE_PARTNER }}
              </dd>
            </div>
            <div class="recipients__row" data-testid="recipients-ALIF_FACTORING">
              <dt class="recipients__label">
                <span class="recipients__dot recipients__dot--acc" aria-hidden="true" />{{
                  t('prices.tiers.ALIF_FACTORING')
                }}
              </dt>
              <dd class="recipients__count num">
                {{ recipients.recipients.byTier.ALIF_FACTORING }}
              </dd>
            </div>
          </dl>
        </div>
        <div class="recipients__group">
          <p class="recipients__head">{{ t('prices.file.byDestination') }}</p>
          <dl class="recipients__list">
            <div class="recipients__row" data-testid="recipients-GROUP">
              <dt class="recipients__label">
                <StaffIcon name="users" :size="14" />{{ t('prices.file.toGroups') }}
              </dt>
              <dd class="recipients__count num">{{ recipients.recipients.byDestination.GROUP }}</dd>
            </div>
            <div class="recipients__row" data-testid="recipients-PRIVATE">
              <dt class="recipients__label">
                <StaffIcon name="user" :size="14" />{{ t('prices.file.toPrivate') }}
              </dt>
              <dd class="recipients__count num">
                {{ recipients.recipients.byDestination.PRIVATE }}
              </dd>
            </div>
          </dl>
        </div>
        <p v-if="skippedTotal > 0" class="recipients__note" data-testid="recipients-skipped">
          {{ t('prices.file.skipped', recipients.skipped) }}
        </p>
      </template>
    </div>
  </AppConfirmDialog>
</template>

<style scoped>
/* The v8 page actions of Narxlar: 40px white buttons with a hairline ring (as the "Tovarlar"
   link next to them). */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.chip:hover {
  background: var(--f5);
}

.chip:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.chip__icon {
  color: var(--t2);
}

/* Design 6A: grey count rows grouped under small headings. */
.recipients {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.recipients__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 6px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.recipients__head {
  padding: 4px 8px;
  font-size: var(--fs-group);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--t2);
}

.recipients__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  font-size: var(--fs-small);
}

.recipients__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.recipients__head {
  margin: 0;
}

.recipients__row dd {
  margin: 0;
}

.recipients__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.recipients__label :deep(svg) {
  color: var(--t2);
}

.recipients__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--t3);
}

.recipients__dot--acc {
  background: var(--acc);
}

.recipients__count {
  font-weight: 600;
}

.recipients__note {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

@media (max-width: 720px) {
  .chip {
    flex: 1 1 auto;
    justify-content: center;
  }
}

@media (pointer: coarse), (hover: none) {
  .chip {
    min-height: 44px;
  }
}
</style>
