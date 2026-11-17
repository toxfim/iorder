<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { hasStaffAccess } from '../access';
import { homeFor } from '@/router/guards';

const { t } = useI18n();
const router = useRouter();
const { currentUser } = useServices();

const user = computed(() => currentUser.user.value);

// Someone without a staff role (a customer, or nobody) is told this app is for staff; someone
// with a role who opened the wrong page just gets the generic "closed for your role" copy.
const hasAnyAccess = computed(() => !!user.value && hasStaffAccess(user.value));

async function leave(): Promise<void> {
  await router.replace(user.value && hasAnyAccess.value ? homeFor(user.value) : { name: 'login' });
}
</script>

<template>
  <main class="forbidden">
    <StateView
      state="denied"
      :title="hasAnyAccess ? undefined : t('auth.denied.title')"
      :description="hasAnyAccess ? undefined : t('auth.denied.description')"
    >
      <template #actions>
        <AppButton variant="outline" @click="leave">{{ t('common.back') }}</AppButton>
      </template>
    </StateView>
  </main>
</template>

<style scoped>
.forbidden {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 16px;
}
</style>
