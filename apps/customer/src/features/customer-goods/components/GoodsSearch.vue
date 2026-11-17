<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import GoodsIcon from './GoodsIcon.vue';
defineProps<{ modelValue: string; placeholder: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
const { t } = useI18n();
</script>
<template>
  <div class="goods-search">
    <label :for="id" class="sr-only">{{ placeholder }}</label
    ><GoodsIcon name="search" /><input
      :id="id"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      maxlength="512"
      autocomplete="off"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    /><button
      v-if="modelValue"
      type="button"
      :aria-label="t('customer.goods.clear')"
      @click="emit('update:modelValue', '')"
    >
      <GoodsIcon name="close" />
    </button>
  </div>
</template>
