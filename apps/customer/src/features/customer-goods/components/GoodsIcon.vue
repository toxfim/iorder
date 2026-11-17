<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  name:
    | 'phone'
    | 'phone-accent'
    | 'check-neutral'
    | 'headphones'
    | 'tv'
    | 'box'
    | 'right'
    | 'back'
    | 'search'
    | 'copy'
    | 'close'
    | 'check'
    | 'pending'
    | 'box-empty'
    | 'box-status';
}>();
const sizes = {
  phone: 24,
  'phone-accent': 24,
  'check-neutral': 18,
  headphones: 24,
  tv: 24,
  box: 32,
  right: 20,
  back: 18,
  search: 20,
  copy: 18,
  close: 18,
  check: 20,
  pending: 18,
  'box-empty': 36,
  'box-status': 22,
};
// Bundled, not in public/: the app's public folder is the shared one in web-core, so a file there
// would answer with index.html and show a broken image.
const urls = import.meta.glob<string>('../assets/goods-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});
const src = computed(
  () => urls[`../assets/goods-icons/${props.name === 'box' ? 'box-discovery' : props.name}.svg`],
);
</script>
<template>
  <img
    class="goods-icon"
    :src="src"
    :width="sizes[props.name]"
    :height="sizes[props.name]"
    alt=""
    aria-hidden="true"
  />
</template>
<style scoped>
.goods-icon {
  flex: none;
  display: block;
  max-width: none;
}
</style>
