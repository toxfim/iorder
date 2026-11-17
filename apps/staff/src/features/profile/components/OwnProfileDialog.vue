<script setup lang="ts">
import { phoneSchema } from '@iorder/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import type { OwnProfile } from '@/features/staff-profile/api/own-profile-api';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import TextField from '@core/components/ui/TextField.vue';
import { showToast } from '@core/composables/use-toast';
import { ApiRateLimitedError, ApiValidationError } from '@core/lib/api-errors';
import { formatPhoneDigits, PHONE_MAX_DIGITS, phoneDigits as digitsOf } from '@core/lib/phone';
import { describePricingError } from '@core/lib/price-errors';

// The signed-in staff member changes their OWN name and phone ([C] 2026-11-09). The server acts
// on the caller only, so nothing here names a person. Unlike a customer's, a staff phone may be
// left empty: the account works without one.
const props = defineProps<{
  modelValue: boolean;
  /** What is saved now: the form starts from it and "nothing changed" is judged against it. */
  profile: OwnProfile;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [profile: OwnProfile];
}>();

const NAME_MAX_LENGTH = 200;

const { t } = useI18n();
const { ownProfileApi } = useServices();

const fullName = ref('');
const phoneDigits = ref('');
const attempted = ref(false);
const busy = ref(false);
const generalError = ref<string | null>(null);
// The server's word about a field stands until the person changes that field.
const refused = ref<{ fullName: string | null; phone: string | null }>({
  fullName: null,
  phone: null,
});

// Every opening starts from the saved values: a cancelled attempt's typing is not shown again.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    fullName.value = props.profile.fullName;
    phoneDigits.value = digitsOf(props.profile.phone ?? '');
    attempted.value = false;
    busy.value = false;
    generalError.value = null;
    refused.value = { fullName: null, phone: null };
  },
  { immediate: true },
);
watch(fullName, () => (refused.value.fullName = null));
watch(phoneDigits, () => (refused.value.phone = null));

const trimmedName = computed(() => fullName.value.trim());
const phone = computed(() => (phoneDigits.value === '' ? null : `+${phoneDigits.value}`));
const phoneValid = computed(
  () => phone.value === null || phoneSchema.safeParse(phone.value).success,
);
const nameError = computed(() =>
  attempted.value && trimmedName.value === ''
    ? t('staffProfile.edit.errors.name')
    : refused.value.fullName,
);
const phoneError = computed(() =>
  attempted.value && !phoneValid.value ? t('staffProfile.edit.errors.phone') : refused.value.phone,
);
const unchanged = computed(
  () => trimmedName.value === props.profile.fullName.trim() && phone.value === props.profile.phone,
);

function showFailure(caught: unknown): void {
  if (caught instanceof ApiRateLimitedError) {
    generalError.value = t('staffProfile.edit.errors.rateLimited');
    return;
  }
  if (caught instanceof ApiValidationError) {
    // The server names the field; its sentence goes under that field, not above the buttons.
    const paths = caught.issues.map((issue) => issue.path);
    const name = paths.includes('fullName') ? t('staffProfile.edit.errors.name') : null;
    const number = paths.includes('phone') ? t('staffProfile.edit.errors.phone') : null;
    if (name !== null || number !== null) {
      refused.value = { fullName: name, phone: number };
      return;
    }
  }
  const described = describePricingError('load', caught);
  generalError.value = t(described.key, { ...described.params });
}

async function save(): Promise<void> {
  // One press is one request: a second press while the first runs does nothing.
  if (busy.value) return;
  attempted.value = true;
  if (trimmedName.value === '' || !phoneValid.value) return;
  // Nothing was edited: there is nothing to save, so no request is made.
  if (unchanged.value) {
    emit('update:modelValue', false);
    return;
  }
  busy.value = true;
  generalError.value = null;
  try {
    const saved = await ownProfileApi.update({ fullName: trimmedName.value, phone: phone.value });
    emit('saved', saved);
    emit('update:modelValue', false);
    showToast({ message: t('staffProfile.edit.saved') });
  } catch (caught) {
    showFailure(caught);
  } finally {
    busy.value = false;
  }
}

// Enter that picks an IME candidate (keyCode 229 on some browsers) must not save the half-typed name.
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void save();
}
</script>

<template>
  <AppConfirmDialog
    :model-value="modelValue"
    :title="t('staffProfile.edit.title')"
    :description="t('staffProfile.edit.description')"
    :confirm-label="t('staffProfile.edit.save')"
    :loading="busy"
    :error="generalError"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="save"
  >
    <form class="form" novalidate @submit.prevent="save" @keydown.enter="onEnter">
      <TextField
        v-model="fullName"
        :label="t('staffProfile.edit.name')"
        :maxlength="NAME_MAX_LENGTH"
        :error="nameError"
        :disabled="busy"
        autocomplete="name"
      />
      <TextField
        v-model="phoneDigits"
        digits-only
        prefix="+"
        :format="formatPhoneDigits"
        :max-digits="PHONE_MAX_DIGITS"
        :label="t('staffProfile.edit.phone')"
        :hint="t('staffProfile.edit.phoneHint')"
        :error="phoneError"
        :disabled="busy"
        autocomplete="tel-national"
      />
    </form>
  </AppConfirmDialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
