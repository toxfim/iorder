<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  phoneSchema,
  type StaffOrganizationResponse,
  type StaffOrganizationSummary,
} from '@iorder/shared';
import { useServices } from '@/app/services';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import TextField from '@core/components/ui/TextField.vue';
import { showToast } from '@core/composables/use-toast';
import { formatPhoneDigits, PHONE_MAX_DIGITS, phoneDigits as digitsOf } from '@core/lib/phone';
import type { OrganizationDetailsChange } from '../api/organizations-api';
import { describeOrganizationError } from '../domain/organization-model';

// The organization's name and contact phone (manager, admin) [C, owner 2026-11-11]. The label and
// the type (unbound only) have their own controls on the page; the Telegram chat is never edited.
// The list hands in its row (a summary), the detail page the whole organization.
const props = defineProps<{ modelValue: boolean; organization: StaffOrganizationSummary }>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  saved: [organization: StaffOrganizationResponse];
}>();

const NAME_MAX_LENGTH = 200;

const { t } = useI18n();
const { organizationsApi } = useServices();

const name = ref('');
const phoneDigits = ref('');
const attempted = ref(false);
const busy = ref(false);
const failure = ref<string | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    name.value = props.organization.name;
    phoneDigits.value = digitsOf(props.organization.phone ?? '');
    attempted.value = false;
    busy.value = false;
    failure.value = null;
  },
  { immediate: true },
);

const trimmedName = computed(() => name.value.trim());
const phone = computed(() => (phoneDigits.value === '' ? null : `+${phoneDigits.value}`));
const phoneValid = computed(
  () => phone.value === null || phoneSchema.safeParse(phone.value).success,
);
const nameError = computed(() =>
  attempted.value && trimmedName.value === '' ? t('organizations.create.errors.name') : null,
);
const phoneError = computed(() =>
  attempted.value && !phoneValid.value ? t('organizations.create.errors.phone') : null,
);

async function save(): Promise<void> {
  if (busy.value) return;
  attempted.value = true;
  if (trimmedName.value === '' || !phoneValid.value) return;
  const change: OrganizationDetailsChange = {
    ...(trimmedName.value !== props.organization.name ? { name: trimmedName.value } : {}),
    ...(phone.value !== props.organization.phone ? { phone: phone.value } : {}),
  };
  // Nothing was edited: no request.
  if (Object.keys(change).length === 0) {
    emit('update:modelValue', false);
    return;
  }
  busy.value = true;
  failure.value = null;
  try {
    const saved = await organizationsApi.update(props.organization.id, change);
    emit('saved', saved);
    emit('update:modelValue', false);
    showToast({ message: t('organizations.edit.saved') });
  } catch (caught) {
    failure.value = t(describeOrganizationError(caught).key);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppConfirmDialog
    :model-value="modelValue"
    :title="t('organizations.edit.title')"
    :confirm-label="t('organizations.edit.save')"
    :loading="busy"
    :error="failure"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="save"
  >
    <form class="form" novalidate data-testid="edit-org-form" @submit.prevent="save">
      <TextField
        v-model="name"
        :label="t('organizations.edit.name')"
        :maxlength="NAME_MAX_LENGTH"
        :error="nameError"
        :disabled="busy"
      />
      <TextField
        v-model="phoneDigits"
        digits-only
        prefix="+"
        :format="formatPhoneDigits"
        :max-digits="PHONE_MAX_DIGITS"
        :label="t('organizations.edit.phone')"
        :error="phoneError"
        :disabled="busy"
        autocomplete="off"
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
