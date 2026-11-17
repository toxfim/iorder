<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS,
  type OrganizationType,
  type StaffOrganizationInviteResponse,
} from '@iorder/shared';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { inviteTimeLeft } from '../domain/organization-model';

// The one-time bot link of an organization without a chat [C, owner 2026-11-11; link rules P]:
// the new-organization dialog's second step and the detail page show it alike. A PERSON link
// opens a private chat with the bot, a GROUP link adds the bot to a group.
const props = withDefaults(
  defineProps<{
    invite: StaffOrganizationInviteResponse;
    type: OrganizationType;
    /** The detail page offers a new link (manager, admin); the dialog does not. */
    canRegenerate?: boolean;
    regenerating?: boolean;
  }>(),
  { canRegenerate: false, regenerating: false },
);
const emit = defineEmits<{ regenerate: [] }>();

const { t } = useI18n();
const { clock } = useServices();

const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
watch(
  () => props.invite.url,
  () => (copyState.value = 'idle'),
);

const left = computed(() =>
  props.invite.status === 'PENDING' ? inviteTimeLeft(props.invite.expiresAt, clock.now()) : null,
);
const expired = computed(() => props.invite.status === 'EXPIRED' || left.value === null);
const ttlDays = Math.round(DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS / 86_400);
const shareUrl = computed(() =>
  props.invite.url === null
    ? null
    : `https://t.me/share/url?url=${encodeURIComponent(props.invite.url)}`,
);

// The clipboard may be unavailable (insecure context, denied permission): say so, and the link
// stays selectable in its field.
async function copy(): Promise<void> {
  if (props.invite.url === null) return;
  try {
    await navigator.clipboard.writeText(props.invite.url);
    copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
}

function selectAll(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
</script>

<template>
  <div class="invite" data-testid="invite-card">
    <div class="invite__head">
      <p class="invite__hint">
        {{
          type === 'GROUP'
            ? t('organizations.invite.hintGroup')
            : t('organizations.invite.hintPerson')
        }}
      </p>
      <AppBadge v-if="!expired && left" tone="warning" data-testid="invite-time-left">
        {{ t('organizations.invite.timeLeft', { days: left.days, hours: left.hours }) }}
      </AppBadge>
      <AppBadge v-else tone="danger" data-testid="invite-expired">
        {{ t('organizations.invite.expired') }}
      </AppBadge>
    </div>

    <template v-if="!expired">
      <div v-if="invite.url !== null" class="invite__row">
        <input
          class="invite__field mono"
          readonly
          :value="invite.url"
          :aria-label="t('organizations.invite.field')"
          data-testid="invite-url"
          @focus="selectAll"
        />
        <AppButton variant="secondary" size="sm" data-testid="invite-copy" @click="copy">
          <StaffIcon name="copy" :size="15" />{{ t('organizations.invite.copy') }}
        </AppButton>
        <a
          v-if="shareUrl"
          class="invite__share"
          :href="shareUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="invite-share"
        >
          <StaffIcon name="send" :size="15" />{{ t('organizations.invite.share') }}
        </a>
      </div>
      <p v-else class="invite__note" role="note" data-testid="invite-bot-missing">
        {{ t('organizations.invite.botMissing') }}
      </p>
      <p v-if="copyState === 'copied'" class="invite__note" role="status">
        {{ t('organizations.invite.copied') }}
      </p>
      <p v-else-if="copyState === 'failed'" class="invite__note" role="status">
        {{ t('organizations.invite.copyFailed') }}
      </p>
      <p v-if="!canRegenerate" class="invite__note">
        {{ t('organizations.invite.once', { days: ttlDays }) }}
      </p>
    </template>
    <p v-else class="invite__note" role="note">{{ t('organizations.invite.expiredHint') }}</p>

    <div v-if="canRegenerate" class="invite__regen">
      <AppButton
        variant="secondary"
        size="sm"
        :loading="regenerating"
        data-testid="invite-regenerate"
        @click="emit('regenerate')"
      >
        <StaffIcon name="refresh" :size="15" />{{ t('organizations.invite.regenerate') }}
      </AppButton>
      <p class="invite__note">{{ t('organizations.invite.regenerateHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.invite {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.invite__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 16px;
}

.invite__hint {
  flex: 1 1 260px;
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.invite__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.invite__field {
  flex: 1 1 260px;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-input);
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
}

.invite__field:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.invite__share {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--r-btn-sm);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font-size: var(--fs-small);
  font-weight: 600;
  text-decoration: none;
}

.invite__share:hover {
  background: var(--f5);
}

.invite__share:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.invite__note {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t2);
}

.invite__regen {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

@media (pointer: coarse), (hover: none) {
  .invite__share,
  .invite__field {
    min-height: 44px;
  }
}
</style>
