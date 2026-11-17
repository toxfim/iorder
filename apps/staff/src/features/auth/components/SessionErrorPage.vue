<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import StateView from '@core/components/ui/StateView.vue';
import { safeRedirect } from '../redirect';

const route = useRoute();
const router = useRouter();
const { currentUser } = useServices();
const busy = ref(false);

// The start-up read of the session failed (network, server trouble). The token is kept: only
// a 401 means the session is over.
async function retry(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await currentUser.retry();
    if (currentUser.loadError.value === null) {
      // The guard sends the person home when the remembered page is not theirs.
      await router.replace(safeRedirect(route.query.redirect) ?? '/');
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="session-error">
    <StateView state="error" @retry="retry" />
  </main>
</template>

<style scoped>
.session-error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 16px;
}
</style>
