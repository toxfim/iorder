<script setup lang="ts">
import TelegramLoginWidget from '@core/telegram/components/TelegramLoginWidget.vue';
defineProps<{ botUsername: string }>();
const emit = defineEmits<{ auth: [payload: Readonly<Record<string, unknown>>] }>();
</script>
<template>
  <TelegramLoginWidget :bot-username="botUsername" @auth="emit('auth', $event)" />
</template>
