<script setup lang="ts">
import type { ProductImageResponse } from '@iorder/shared';
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { showToast } from '@core/composables/use-toast';
import { NetworkError, PermissionDeniedError, RequestTimeoutError } from '@core/lib/api-errors';
import { translateDescribed } from '@/features/pricing/domain/translate-error';
import {
  PHOTO_ACCEPT,
  PHOTO_MAX_MB,
  checkPhotoFile,
  describePhotoError,
  newUploadKey,
} from '../domain/photo-upload';
import ProductThumb from './ProductThumb.vue';

// The photos of one product inside the price and product dialogs (manager, admin; the parent
// renders it only for them, the server enforces MANAGE_PRODUCT_IMAGES). Upload one file at a
// time; the server makes the first photo main and never replaces a main photo silently, so
// switching is its own button. Removal asks first, inline like the price removal.
const props = defineProps<{
  productCode: string;
  /** The product name: alternative text of the photos. */
  name: string;
  /** The dialog is busy with its own save: the photo actions wait. */
  disabled?: boolean;
  /**
   * A photo was (or may have been) added, switched or removed: the lists refresh their thumbnail.
   * A callback, not an emit: the dialog may close (and unmount this) before the request ends, and
   * Vue drops the emits of an unmounted component.
   */
  afterChange?: () => void;
  /** A photo request starts (true) or ends (false): the dialog holds its own save meanwhile. */
  busyChange?: (busy: boolean) => void;
}>();

const { t } = useI18n();
const { productImagesApi } = useServices();
const inputId = useId();

type LoadState = 'loading' | 'ready' | 'error' | 'denied';
const state = ref<LoadState>('loading');
const images = shallowRef<readonly ProductImageResponse[]>([]);
// 'upload', or the id of the photo being switched or removed.
const busy = ref<string | null>(null);
const failure = ref<string | null>(null);
const confirmId = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);
let run = 0;

async function load(): Promise<void> {
  const mine = ++run;
  state.value = 'loading';
  try {
    const product = await productImagesApi.getProduct(props.productCode);
    if (mine !== run) return;
    images.value = product.images;
    state.value = 'ready';
  } catch (caught) {
    if (mine !== run) return;
    state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
  }
}

watch(
  () => props.productCode,
  () => {
    failure.value = null;
    confirmId.value = null;
    void load();
  },
  { immediate: true },
);

const locked = computed(() => props.disabled === true || busy.value !== null);

async function act(kind: string, work: () => Promise<void>, done: string): Promise<void> {
  busy.value = kind;
  props.busyChange?.(true);
  failure.value = null;
  try {
    await work();
    showToast({ message: t(done) });
    props.afterChange?.();
    await load();
  } catch (caught) {
    failure.value = translateDescribed(t, describePhotoError(caught));
    // No answer is not a refusal: the server may have stored the change, so read it again.
    if (caught instanceof NetworkError || caught instanceof RequestTimeoutError) {
      props.afterChange?.();
      await load();
    }
  } finally {
    busy.value = null;
    props.busyChange?.(false);
  }
}

function onFile(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  // Cleared at once, so choosing the same file again after a fix fires `change` again.
  target.value = '';
  if (!file || locked.value) return;
  const problem = checkPhotoFile(file);
  if (problem) {
    failure.value = t(`photos.errors.${problem}`, { mb: PHOTO_MAX_MB });
    return;
  }
  // A new key per attempt: the api replays a retried key and refuses it for another file.
  const key = newUploadKey();
  void act(
    'upload',
    async () => {
      await productImagesApi.upload(props.productCode, file, key);
    },
    'photos.uploaded',
  );
}

function makePrimary(image: ProductImageResponse): void {
  void act(
    image.imageId,
    async () => {
      await productImagesApi.setPrimary(image.imageId);
    },
    'photos.primarySet',
  );
}

function remove(image: ProductImageResponse): void {
  void act(
    image.imageId,
    async () => {
      await productImagesApi.remove(image.imageId);
      confirmId.value = null;
    },
    'photos.removed',
  );
}
</script>

<template>
  <section class="photos" :aria-labelledby="`${inputId}-title`" :aria-busy="busy !== null">
    <div class="photos__head">
      <h3 :id="`${inputId}-title`" class="photos__title">{{ t('photos.title') }}</h3>
      <template v-if="state === 'ready'">
        <input
          :id="inputId"
          ref="input"
          class="sr-only"
          type="file"
          :accept="PHOTO_ACCEPT"
          :disabled="locked"
          data-testid="photo-input"
          @change="onFile"
        />
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="locked"
          :loading="busy === 'upload'"
          data-testid="photo-upload"
          @click="input?.click()"
        >
          <StaffIcon name="image" :size="14" />
          {{ busy === 'upload' ? t('photos.uploading') : t('photos.upload') }}
        </AppButton>
      </template>
    </div>

    <p v-if="state === 'loading'" class="photos__note" role="status">{{ t('state.loading') }}</p>
    <p v-else-if="state === 'denied'" class="photos__note">{{ t('photos.denied') }}</p>
    <p v-else-if="state === 'error'" class="photos__note photos__note--error" role="alert">
      {{ t('photos.loadFailed') }}
      <AppButton variant="secondary" size="xs" @click="load">{{ t('state.retry') }}</AppButton>
    </p>

    <template v-else>
      <p v-if="images.length === 0" class="photos__note" data-testid="photos-empty">
        {{ t('photos.empty') }}
      </p>
      <ul v-else class="photos__list">
        <li
          v-for="(image, index) in images"
          :key="image.imageId"
          class="tile"
          :class="{ 'tile--primary': image.isPrimary }"
          data-testid="photo-tile"
        >
          <ProductThumb
            :src="image.thumbUrl"
            :large-src="image.url"
            :alt="t('photos.alt', { name, index: index + 1 })"
            :size="64"
          />
          <span v-if="image.isPrimary" class="tile__badge">{{ t('photos.primary') }}</span>
          <div v-if="confirmId === image.imageId" class="confirm" role="group">
            <span class="confirm__text">{{ t('photos.removeQuestion') }}</span>
            <div class="confirm__actions">
              <AppButton
                variant="secondary"
                size="xs"
                :disabled="busy !== null"
                @click="confirmId = null"
              >
                {{ t('common.cancel') }}
              </AppButton>
              <AppButton
                variant="danger"
                size="xs"
                :loading="busy === image.imageId"
                data-testid="photo-remove-confirm"
                @click="remove(image)"
              >
                {{ t('photos.removeConfirm') }}
              </AppButton>
            </div>
          </div>
          <div v-else class="tile__actions">
            <button
              v-if="!image.isPrimary"
              type="button"
              class="tile__action"
              :disabled="locked"
              :aria-label="t('photos.makePrimaryLabel', { index: index + 1 })"
              :title="t('photos.makePrimary')"
              data-testid="photo-primary"
              @click="makePrimary(image)"
            >
              <StaffIcon name="star" :size="14" />
            </button>
            <button
              type="button"
              class="tile__action tile__action--danger"
              :disabled="locked"
              :aria-label="t('photos.removeLabel', { index: index + 1 })"
              :title="t('photos.remove')"
              data-testid="photo-remove"
              @click="confirmId = image.imageId"
            >
              <StaffIcon name="trash" :size="14" />
            </button>
          </div>
        </li>
      </ul>
      <p class="photos__hint">{{ t('photos.hint', { mb: PHOTO_MAX_MB }) }}</p>
    </template>

    <p v-if="failure" class="photos__note photos__note--error" role="alert">{{ failure }}</p>
  </section>
</template>

<style scoped>
.photos {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.photos__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.photos__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--ink);
}

.photos__list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.tile--primary :deep(.thumb) {
  box-shadow: inset 0 0 0 2px var(--acc);
}

.tile__badge {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 1px 6px;
  border-radius: var(--r-kbd);
  background: var(--acc);
  color: var(--acc-on);
  font-size: var(--fs-group);
  font-weight: 600;
  pointer-events: none;
}

.tile__actions {
  display: flex;
  gap: 4px;
}

.tile__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--r-kbd);
  background: var(--f5);
  color: var(--t2);
  cursor: pointer;
}

.tile__action:hover:not(:disabled) {
  color: var(--ink);
}

.tile__action--danger:hover:not(:disabled) {
  color: var(--red);
}

.tile__action:disabled {
  cursor: default;
  color: var(--t3);
}

.tile__action:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 220px;
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-meta);
}

.confirm__actions {
  display: flex;
  gap: 6px;
}

.photos__note,
.photos__hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.photos__hint {
  color: var(--t3);
}

.photos__note--error {
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
}

@media (pointer: coarse) {
  .tile__action {
    width: 44px;
    height: 44px;
  }
}
</style>
