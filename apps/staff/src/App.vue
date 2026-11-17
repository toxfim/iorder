<script setup lang="ts">
import { useRoute } from 'vue-router';
import AppErrorBoundary from '@core/components/ui/AppErrorBoundary.vue';
import ToastHost from '@core/components/ui/ToastHost.vue';
import { useDocumentTitle } from '@core/composables/use-document-title';

const route = useRoute();
useDocumentTitle();
</script>

<template>
  <AppErrorBoundary :reset-key="route.fullPath">
    <RouterView />
  </AppErrorBoundary>
  <ToastHost />
</template>
