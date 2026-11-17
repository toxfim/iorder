<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { mountTelegramWidget } from '../telegram-widget';

const props = defineProps<{ botUsername: string }>();
const emit = defineEmits<{ auth: [payload: Readonly<Record<string, unknown>>] }>();

const { t } = useI18n();
const host = ref<HTMLElement | null>(null);
const loadFailed = ref(false);
let unmount: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  unmount = mountTelegramWidget(host.value, props.botUsername, {
    onAuth: (payload) => emit('auth', payload),
    onLoadError: () => {
      loadFailed.value = true;
    },
  });
});

onBeforeUnmount(() => {
  unmount?.();
  unmount = null;
});
</script>

<template>
  <div class="tg">
    <div ref="host" class="tg__host" />
    <p v-if="loadFailed" class="tg__note" role="status">
      {{ t('telegramWidget.unavailable') }}
    </p>
  </div>
</template>

<style scoped>
.tg__host {
  display: flex;
  justify-content: center;
  min-height: var(--tap-min);
}

.tg__note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
  text-align: center;
}
</style>
