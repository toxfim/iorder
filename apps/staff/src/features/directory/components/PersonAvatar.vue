<script setup lang="ts">
import { computed } from 'vue';
import { initialsOf } from '../domain/directory-model';

const props = withDefaults(defineProps<{ name: string; size?: 'md' | 'lg' }>(), { size: 'md' });
const initials = computed(() => initialsOf(props.name));
</script>

<template>
  <span class="avatar" :class="`avatar--${size}`" aria-hidden="true">{{ initials }}</span>
</template>

<style scoped>
/* v8 person avatar: an accent-tinted circle with the initials in the accent text colour. */
.avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-weight: 600;
}

.avatar--md {
  width: 32px;
  height: 32px;
  font-size: var(--fs-meta);
}

.avatar--lg {
  width: 56px;
  height: 56px;
  font-size: 18px;
}
</style>
