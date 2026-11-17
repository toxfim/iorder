<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { ApiNotFoundError, ApiRateLimitedError, PermissionDeniedError } from '@core/lib/api-errors';
import { leaveTo } from '@core/lib/leave-page';
import { cameFromCustomerSite, takeHandoffIntent } from '../handoff-intent';

// The one page that hands a signed-in staff member over to the customer site ([C] 2026-11-09). It
// is reached two ways: the "Customer site" entry of the sidebar (a new tab), and the customer site
// itself, which sends a returning staff member here once. Either way the page asks the api for a
// one-time code with the dashboard session and goes where the api says. A person who is not
// signed in meets the normal sign-in first (the route guard) and continues here afterwards.
//
// It goes ahead by itself only on an intent of the person (handoff-intent.ts): the sidebar card
// was pressed, or the customer site sent them (its origin is the referrer). A bare navigation,
// which any website could cause, only shows a button and does nothing until it is pressed.
type Phase = 'confirm' | 'opening' | 'failed' | 'rateLimited' | 'unavailable';

const { t } = useI18n();
const { customerSiteApi, customerSiteStore } = useServices();
const phase = ref<Phase>('opening');

async function start(): Promise<void> {
  if (takeHandoffIntent()) return open();
  await customerSiteStore.ensureLoaded();
  if (cameFromCustomerSite(document.referrer, customerSiteStore.url.value)) return open();
  phase.value = 'confirm';
}

async function open(): Promise<void> {
  phase.value = 'opening';
  try {
    // Asked for right now: the code lives for about a minute and works once.
    const url = await customerSiteApi.requestHandoff();
    // This browser holds a dashboard session that can be handed over: leave the non-secret hint
    // for the customer site (the address only, without the code in its fragment).
    customerSiteStore.noteHandedOver(url.split('#', 1)[0] ?? url);
    if (!leaveTo(url)) phase.value = 'failed';
  } catch (caught) {
    if (caught instanceof ApiRateLimitedError) phase.value = 'rateLimited';
    else if (caught instanceof ApiNotFoundError || caught instanceof PermissionDeniedError) {
      phase.value = 'unavailable';
    } else phase.value = 'failed';
  }
}

const failure = computed(() => {
  switch (phase.value) {
    case 'rateLimited':
      return {
        title: t('customerSite.handoff.failedTitle'),
        description: t('customerSite.handoff.rateLimited'),
      };
    case 'unavailable':
      return {
        title: t('customerSite.handoff.unavailableTitle'),
        description: t('customerSite.handoff.unavailableDescription'),
      };
    default:
      return {
        title: t('customerSite.handoff.failedTitle'),
        description: t('customerSite.handoff.failedDescription'),
      };
  }
});

onMounted(start);
</script>

<template>
  <main class="handoff">
    <div v-if="phase === 'confirm'" class="handoff__opening" data-state="confirm">
      <p class="handoff__title">{{ t('customerSite.handoff.confirmTitle') }}</p>
      <p class="handoff__hint">{{ t('customerSite.handoff.confirmDescription') }}</p>
      <div class="handoff__actions">
        <AppButton variant="dark" size="lg" data-testid="handoff-continue" @click="open">
          {{ t('customerSite.handoff.continueButton') }}
        </AppButton>
        <RouterLink class="handoff__back" to="/">
          {{ t('customerSite.handoff.backToDashboard') }}
        </RouterLink>
      </div>
    </div>
    <div
      v-else-if="phase === 'opening'"
      class="handoff__opening"
      role="status"
      data-state="opening"
    >
      <span class="handoff__spinner" aria-hidden="true" />
      <p class="handoff__title">{{ t('customerSite.handoff.opening') }}</p>
      <p class="handoff__hint">{{ t('customerSite.handoff.openingHint') }}</p>
    </div>
    <!-- "Unavailable" has nothing to retry: the denied state shows no retry button. -->
    <StateView
      v-else
      :state="phase === 'unavailable' ? 'denied' : 'error'"
      :title="failure.title"
      :description="failure.description"
      @retry="open"
    >
      <template #actions>
        <RouterLink class="handoff__back" to="/">
          {{ t('customerSite.handoff.backToDashboard') }}
        </RouterLink>
      </template>
    </StateView>
  </main>
</template>

<style scoped>
.handoff {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 16px;
  background: var(--page);
}

.handoff__opening {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  text-align: center;
}

.handoff__spinner {
  width: 28px;
  height: 28px;
  margin-bottom: 6px;
  border: 3px solid var(--e8);
  border-top-color: var(--ink);
  border-radius: 50%;
  animation: handoff-spin 0.8s linear infinite;
}

.handoff__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
}

.handoff__hint {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t3);
}

.handoff__actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.handoff__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap-min);
  padding: 0 12px;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.handoff__back:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  border-radius: var(--r-btn-sm);
}

@keyframes handoff-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .handoff__spinner {
    animation-duration: 2.4s;
  }
}
</style>
