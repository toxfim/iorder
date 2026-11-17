<script setup lang="ts">
import { phoneSchema, type SetOwnContactRequest } from '@iorder/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import TextField from '@core/components/ui/TextField.vue';
import { formatPhoneDigits, PHONE_MAX_DIGITS, phoneDigits as digitsOf } from '@core/lib/phone';
import type { ContactFailure } from '../composables/contact-failure';

// The customer's own name and phone. Asked when they place the first order (`first-order`) and
// changed later from the profile (`edit`). The number is unverified; the manager calls it.
// Nothing typed here is kept anywhere but in this component's state until the request is sent
// (never in a URL, the storage or a log).
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    mode?: 'first-order' | 'edit';
    /** The name to start from (the one Telegram gave, or the saved one); the person can change it. */
    initialName: string;
    /** The saved phone (`+998...`) to start from; the first order has none. */
    initialPhone?: string | null;
    loading?: boolean;
    /** Why the last request failed; the dialog stays open to show it, at the field when one is named. */
    failure?: ContactFailure | null;
  }>(),
  { mode: 'first-order', initialPhone: null, loading: false, failure: null },
);
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [request: SetOwnContactRequest];
}>();

const NAME_MAX_LENGTH = 200;

const { t } = useI18n();
const fullName = ref('');
const phoneDigits = ref('');
const attempted = ref(false);
// The server's word about a field stands until the person changes that field.
const refused = ref<{ fullName: string | null; phone: string | null }>({
  fullName: null,
  phone: null,
});

// Every opening starts clean: the previous attempt's typing is not shown again.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    fullName.value = props.initialName;
    phoneDigits.value = digitsOf(props.initialPhone ?? '');
    attempted.value = false;
    refused.value = { fullName: null, phone: null };
  },
  { immediate: true },
);
watch(
  () => props.failure,
  (failure) => {
    refused.value = {
      fullName: failure?.fields.fullName ?? null,
      phone: failure?.fields.phone ?? null,
    };
  },
);
watch(fullName, () => (refused.value.fullName = null));
watch(phoneDigits, () => (refused.value.phone = null));

const trimmedName = computed(() => fullName.value.trim());
const phone = computed(() => `+${phoneDigits.value}`);
const nameError = computed(() =>
  attempted.value && trimmedName.value === ''
    ? t('customer.contact.errors.name')
    : refused.value.fullName,
);
const phoneError = computed(() =>
  attempted.value && !phoneSchema.safeParse(phone.value).success
    ? t('customer.contact.errors.phone')
    : refused.value.phone,
);
const unchanged = computed(
  () =>
    props.mode === 'edit' &&
    trimmedName.value === props.initialName.trim() &&
    phone.value === (props.initialPhone ?? ''),
);
const texts = computed(() =>
  props.mode === 'edit'
    ? {
        title: t('customer.profileEdit.title'),
        description: t('customer.presentation.contactHint'),
        submit: t('customer.profileEdit.submit'),
      }
    : {
        title: t('customer.contact.title'),
        description: t('customer.contact.description'),
        submit: t('customer.contact.submit'),
      },
);

function confirm(): void {
  // One press is one request: a second press while the first runs does nothing.
  if (props.loading) return;
  attempted.value = true;
  // Validated here, before any request leaves the phone.
  if (trimmedName.value === '' || !phoneSchema.safeParse(phone.value).success) return;
  // Nothing was edited: there is nothing to save, so no request is made.
  if (unchanged.value) {
    emit('update:modelValue', false);
    return;
  }
  emit('confirm', { fullName: trimmedName.value, phone: phone.value });
}

// Enter that picks an IME candidate (keyCode 229 on some browsers) must not save the half-typed name.
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  confirm();
}
</script>

<template>
  <AppConfirmDialog
    :model-value="modelValue"
    :title="texts.title"
    :description="texts.description"
    :confirm-label="texts.submit"
    :loading="loading"
    :error="failure?.general"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="confirm"
  >
    <form class="contact" novalidate @submit.prevent="confirm" @keydown.enter="onEnter">
      <TextField
        v-model="fullName"
        :label="t('customer.contact.name')"
        :maxlength="NAME_MAX_LENGTH"
        :error="nameError"
        :disabled="loading"
        autocomplete="name"
      />
      <TextField
        v-model="phoneDigits"
        digits-only
        prefix="+"
        :format="formatPhoneDigits"
        :max-digits="PHONE_MAX_DIGITS"
        :label="t('customer.contact.phone')"
        :hint="t('customer.contact.phoneHint')"
        :error="phoneError"
        :disabled="loading"
        autocomplete="tel-national"
      />
    </form>
  </AppConfirmDialog>
</template>

<style scoped>
.contact {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
