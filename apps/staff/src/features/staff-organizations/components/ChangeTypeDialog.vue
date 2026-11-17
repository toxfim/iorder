<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  OrganizationType,
  StaffOrganizationInviteResponse,
  StaffOrganizationResponse,
  StaffOrganizationSummary,
} from '@iorder/shared';
import { useServices } from '@/app/services';
import AppButton from '@core/components/ui/AppButton.vue';
import AppModal from '@core/components/ui/AppModal.vue';
import { describeOrganizationError } from '../domain/organization-model';
import InviteLinkCard from './InviteLinkCard.vue';

// The list's type change [C, owner 2026-11-12]: the one inline change with a consequence (a link
// already sent was made for the old type and stops connecting), so it confirms first and then
// hands over the NEW link right away: the person need not open the organization to send it.
const props = defineProps<{
  modelValue: boolean;
  organization: StaffOrganizationSummary | null;
  target: OrganizationType | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  /** The server's answer after the change: the list puts it in place of the row. */
  changed: [organization: StaffOrganizationResponse];
  /** A refusal the row must be re-read for (conflict, gone); the message is already translated. */
  stale: [organizationId: string, message: string];
}>();

const { t } = useI18n();
const { organizationsApi } = useServices();

const step = ref<'confirm' | 'link'>('confirm');
const busy = ref(false);
const error = ref<string | null>(null);
const invite = ref<StaffOrganizationInviteResponse | null>(null);
const inviteFailed = ref(false);
const changedType = ref<OrganizationType | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    step.value = 'confirm';
    error.value = null;
    invite.value = null;
    inviteFailed.value = false;
    changedType.value = null;
  },
);

function setOpen(open: boolean): void {
  // Closing while the request runs would hide its outcome.
  if (!open && busy.value) return;
  emit('update:modelValue', open);
}

async function confirm(): Promise<void> {
  const org = props.organization;
  const next = props.target;
  if (!org || !next || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const updated = await organizationsApi.update(org.id, { type: next });
    emit('changed', updated);
    changedType.value = updated.type;
    step.value = 'link';
  } catch (caught) {
    const described = describeOrganizationError(caught);
    if (described.reload) {
      // The row as it now stands is re-read; a repeat would only be refused again.
      emit('stale', org.id, t(described.key));
      emit('update:modelValue', false);
    } else {
      error.value = t(described.key);
    }
    return;
  } finally {
    // The change is done (or refused): reading the link must not keep the dialog from closing.
    busy.value = false;
  }
  try {
    const answer = await organizationsApi.getInvite(org.id);
    // Closed meanwhile (or reopened for another row): the answer belongs to nobody.
    if (props.modelValue && props.organization?.id === org.id) invite.value = answer;
  } catch {
    inviteFailed.value = true;
  }
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="
      step === 'confirm'
        ? t('organizations.detail.typeChangeTitle')
        : t('organizations.inline.linkTitle')
    "
    :description="
      step === 'confirm' && organization && target
        ? t('organizations.detail.typeChangeBody', {
            name: organization.name,
            type: t(`organizations.types.${target}`),
          })
        : undefined
    "
    max-width="520px"
    @update:model-value="setOpen"
  >
    <template v-if="step === 'link' && changedType">
      <p class="lead" role="status">
        {{ t('organizations.inline.linkLead', { type: t(`organizations.types.${changedType}`) }) }}
      </p>
      <InviteLinkCard v-if="invite" :invite="invite" :type="changedType" />
      <p v-else-if="inviteFailed" class="note" role="alert">
        {{ t('organizations.inline.linkFailed') }}
      </p>
      <p v-else class="note" role="status">{{ t('state.loading') }}</p>
    </template>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>

    <template #footer>
      <template v-if="step === 'confirm'">
        <AppButton variant="secondary" size="lg" :disabled="busy" @click="setOpen(false)">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton size="lg" :loading="busy" data-testid="inline-type-confirm" @click="confirm">
          {{ t('organizations.detail.typeChangeConfirm') }}
        </AppButton>
      </template>
      <AppButton v-else size="lg" data-testid="inline-type-done" @click="setOpen(false)">
        {{ t('organizations.inline.done') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
  font-size: var(--fs-small);
  color: var(--t2);
}

.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.error {
  margin: 0;
  font-size: var(--fs-small);
  padding: 10px 12px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
}
</style>
