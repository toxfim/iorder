<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@core/components/ui/AppButton.vue';

defineProps<{ password: string }>();
defineEmits<{ done: [] }>();

const { t } = useI18n();
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

// The clipboard may be unavailable (insecure context, denied permission): say so, and the
// password stays selectable on screen.
async function copy(password: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(password);
    copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
}
</script>

<template>
  <section class="once" :aria-label="t('staffUsers.accounts.created.passwordTitle')">
    <h3 class="once__title">{{ t('staffUsers.accounts.created.passwordTitle') }}</h3>
    <code class="once__value" data-testid="generated-password">{{ password }}</code>
    <p class="once__warning" role="alert">{{ t('staffUsers.accounts.created.warning') }}</p>
    <div class="once__actions">
      <AppButton variant="secondary" size="md" data-testid="password-copy" @click="copy(password)">
        {{ t('staffUsers.accounts.created.copy') }}
      </AppButton>
      <AppButton variant="primary" size="md" data-testid="password-done" @click="$emit('done')">
        {{ t('staffUsers.accounts.created.done') }}
      </AppButton>
    </div>
    <p v-if="copyState === 'copied'" class="once__note" role="status">
      {{ t('staffUsers.accounts.created.copied') }}
    </p>
    <p v-else-if="copyState === 'failed'" class="once__note" role="status">
      {{ t('staffUsers.accounts.created.copyFailed') }}
    </p>
  </section>
</template>

<style scoped>
.once {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.once__title {
  margin: 0;
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.once__value {
  padding: 12px;
  border-radius: var(--r-input);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-family: var(--font-mono);
  font-size: var(--fs-body-lg);
  overflow-wrap: anywhere;
  user-select: all;
}

.once__warning {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-small);
}

.once__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.once__note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}
</style>
