<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_ORGANIZATION_LABEL,
  ORGANIZATION_LABELS,
  ORGANIZATION_TYPES,
  phoneSchema,
  type CreateOrganizationResponse,
  type OrganizationLabel,
  type OrganizationType,
} from '@iorder/shared';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import TextField from '@core/components/ui/TextField.vue';
import { showToast } from '@core/composables/use-toast';
import { ApiValidationError } from '@core/lib/api-errors';
import { formatPhoneDigits, PHONE_MAX_DIGITS } from '@core/lib/phone';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { LABEL_TONE, TYPE_TONE } from '../domain/organization-badges';
import { describeOrganizationError } from '../domain/organization-model';
import InviteLinkCard from './InviteLinkCard.vue';

// Design 2A/2B "Yangi tashkilot" [C, owner 2026-11-11]: staff create a GROUP or a PERSON with a
// name, an optional phone and a label (Standart by default); the answer carries the one-time bot
// link, shown as the second step. Staff never type a Telegram id: whoever uses the link binds it.
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  created: [result: CreateOrganizationResponse];
  open: [organizationId: string];
}>();

const NAME_MAX_LENGTH = 200;

const { t } = useI18n();
const { organizationsApi } = useServices();

const type = ref<OrganizationType>('GROUP');
const name = ref('');
const phoneDigits = ref('');
const label = ref<OrganizationLabel>(DEFAULT_ORGANIZATION_LABEL);
const attempted = ref(false);
const busy = ref(false);
const failure = ref<string | null>(null);
const result = ref<CreateOrganizationResponse | null>(null);

// Every opening starts empty at step one.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    type.value = 'GROUP';
    name.value = '';
    phoneDigits.value = '';
    label.value = DEFAULT_ORGANIZATION_LABEL;
    attempted.value = false;
    busy.value = false;
    failure.value = null;
    result.value = null;
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

const labelOptions = computed(() =>
  ORGANIZATION_LABELS.map((value) => ({ value, label: t(`organizations.labels.${value}`) })),
);

function close(): void {
  if (!busy.value) emit('update:modelValue', false);
}

async function save(): Promise<void> {
  if (busy.value) return;
  attempted.value = true;
  if (trimmedName.value === '' || !phoneValid.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const created = await organizationsApi.create({
      type: type.value,
      name: trimmedName.value,
      phone: phone.value,
      label: label.value,
    });
    result.value = created;
    emit('created', created);
    showToast({ message: t('organizations.create.created', { name: created.organization.name }) });
  } catch (caught) {
    failure.value =
      caught instanceof ApiValidationError
        ? t('apiErrors.validation')
        : t(describeOrganizationError(caught).key);
  } finally {
    busy.value = false;
  }
}

function openPage(): void {
  const id = result.value?.organization.id;
  if (!id) return;
  emit('update:modelValue', false);
  emit('open', id);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('organizations.create.title')"
    :description="result ? undefined : t('organizations.create.description')"
    max-width="520px"
    @update:model-value="(open) => (open ? undefined : close())"
  >
    <ol class="steps" :aria-label="t('organizations.create.steps')">
      <li class="step" :class="result ? 'step--done' : 'step--on'">
        <span class="step__dot" aria-hidden="true">
          <StaffIcon v-if="result" name="check" :size="12" />
          <template v-else>{{ 1 }}</template>
        </span>
        {{ t('organizations.create.stepInfo') }}
      </li>
      <li class="step__line" aria-hidden="true" />
      <li class="step" :class="{ 'step--on': result }" :aria-current="result ? 'step' : undefined">
        <span class="step__dot" aria-hidden="true">{{ 2 }}</span>
        {{ t('organizations.create.stepLink') }}
      </li>
    </ol>

    <form
      v-if="!result"
      class="form"
      novalidate
      data-testid="create-org-form"
      @submit.prevent="save"
    >
      <fieldset class="types">
        <legend class="field-label">{{ t('organizations.create.type') }}</legend>
        <label
          v-for="value in ORGANIZATION_TYPES"
          :key="value"
          class="type"
          :class="{ 'type--on': type === value }"
        >
          <input
            v-model="type"
            class="type__radio"
            type="radio"
            name="organization-type"
            :value="value"
            :disabled="busy"
            :data-testid="`type-${value}`"
          />
          <span class="type__text">
            <b>{{ t(`organizations.types.${value}`) }}</b>
            <span class="type__hint">{{
              value === 'GROUP'
                ? t('organizations.create.groupHint')
                : t('organizations.create.personHint')
            }}</span>
          </span>
        </label>
      </fieldset>

      <TextField
        v-model="name"
        :label="t('organizations.create.name')"
        :maxlength="NAME_MAX_LENGTH"
        :error="nameError"
        :disabled="busy"
        data-testid="create-org-name"
      />
      <TextField
        v-model="phoneDigits"
        digits-only
        prefix="+"
        :format="formatPhoneDigits"
        :max-digits="PHONE_MAX_DIGITS"
        :label="t('organizations.create.phone')"
        :hint="phoneError ? undefined : t('organizations.create.phoneHint')"
        :error="phoneError"
        :disabled="busy"
        autocomplete="off"
        data-testid="create-org-phone"
      />

      <div class="labels">
        <span class="field-label">{{ t('organizations.create.label') }}</span>
        <AppSegmented
          v-model="label"
          class="labels__seg"
          :options="labelOptions"
          :label="t('organizations.create.label')"
          data-testid="create-org-label"
        />
        <span class="hint">{{ t('organizations.create.labelHint') }}</span>
      </div>

      <p class="notice" role="note">
        <StaffIcon name="lock" :size="15" />{{ t('organizations.create.lockNote') }}
      </p>
      <p v-if="failure" class="notice notice--error" role="alert">{{ failure }}</p>
    </form>

    <div v-else class="done" data-testid="create-org-done">
      <dl class="tiles">
        <div class="tile">
          <dt>{{ t('organizations.create.name') }}</dt>
          <dd class="tile__name">{{ result.organization.name }}</dd>
        </div>
        <div class="tile">
          <dt>{{ t('organizations.create.type') }}</dt>
          <dd>
            <AppBadge :tone="TYPE_TONE[result.organization.type]">{{
              t(`organizations.types.${result.organization.type}`)
            }}</AppBadge>
          </dd>
        </div>
        <div class="tile">
          <dt>{{ t('organizations.create.label') }}</dt>
          <dd>
            <AppBadge :tone="LABEL_TONE[result.organization.label]">{{
              t(`organizations.labels.${result.organization.label}`)
            }}</AppBadge>
          </dd>
        </div>
      </dl>
      <h3 class="done__title">{{ t('organizations.invite.title') }}</h3>
      <InviteLinkCard :invite="result.invite" :type="result.organization.type" />
      <p class="notice" role="note">
        <StaffIcon name="bell" :size="15" />{{ t('organizations.invite.notifyNote') }}
      </p>
    </div>

    <template #footer>
      <div class="footer">
        <template v-if="!result">
          <AppButton variant="secondary" :disabled="busy" @click="close">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton :loading="busy" data-testid="create-org-save" @click="save">
            {{ t('organizations.create.save') }}
          </AppButton>
        </template>
        <template v-else>
          <AppButton variant="secondary" @click="close">{{ t('common.close') }}</AppButton>
          <AppButton data-testid="create-org-open" @click="openPage">
            {{ t('organizations.create.openPage') }}
          </AppButton>
        </template>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.steps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--t2);
}

.step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.step__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  font-size: var(--fs-group);
  font-weight: 600;
}

.step--on {
  color: var(--ink);
}

.step--on .step__dot {
  background: var(--acc);
  box-shadow: none;
  color: var(--w);
}

.step--done .step__dot {
  background: var(--green-bg);
  box-shadow: none;
  color: var(--green);
}

.step__line {
  flex: 0 0 32px;
  height: 1px;
  background: var(--e8);
}

.form,
.done {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  padding: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--ink);
}

.types {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.types .field-label {
  flex: 0 0 100%;
}

.type {
  display: flex;
  flex: 1 1 180px;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  cursor: pointer;
}

.type--on {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 1.5px var(--acc);
}

.type:focus-within {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.type__radio {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--acc);
}

.type__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-small);
}

.type__hint,
.hint {
  font-size: var(--fs-meta);
  line-height: 1.45;
  color: var(--t2);
}

.labels {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.labels .field-label {
  margin-bottom: 0;
}

.labels__seg {
  align-self: stretch;
}

.labels__seg :deep(.seg__item) {
  flex: 1 1 0;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
  font-size: var(--fs-meta);
  color: var(--t2);
}

.notice :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.notice--error {
  background: var(--red-bg);
  color: var(--red);
}

.tiles {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 8px;
  margin: 0;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--f5);
}

.tile dt {
  font-size: var(--fs-group);
  color: var(--t2);
}

.tile dd {
  margin: 0;
}

.tile__name {
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.done__title {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
}

.footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}

@media (max-width: 520px) {
  .tiles {
    grid-template-columns: 1fr 1fr;
  }

  .tile:first-child {
    grid-column: 1 / -1;
  }
}
</style>
