<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { showToast } from '@core/composables/use-toast';
import { initialsOf } from '@/features/directory/domain/directory-model';

// Design v8 sidebar user block: avatar initials, name, role and a sign-out icon button.
const { t } = useI18n();
const router = useRouter();
const { currentUser } = useServices();

const user = computed(() => currentUser.user.value);
const initials = computed(() => initialsOf(user.value?.displayName ?? ''));

const roleLabel = computed(() => {
  const current = user.value;
  if (!current) return '';
  const staff = current.staffRoles.map((role) => t(`roles.staff.${role}`));
  if (staff.length > 0) return staff.join(', ');
  return current.organization ? t(`roles.organization.${current.organization.role}`) : '';
});

const signingOut = ref(false);

async function signOut(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await currentUser.signOut();
  } catch (caught) {
    // The session was not ended, so the user block stays as it is; just say it failed.
    console.error(caught);
    showToast({ message: t('state.error.title') });
    return;
  } finally {
    signingOut.value = false;
  }
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div v-if="user" class="user">
    <span class="user__avatar" aria-hidden="true">{{ initials }}</span>
    <span class="user__text">
      <span class="user__name">{{ user.displayName }}</span>
      <span class="user__role">{{ roleLabel }}</span>
    </span>
    <button
      type="button"
      class="user__signout"
      :aria-label="t('auth.signOut')"
      :title="t('auth.signOut')"
      :aria-busy="signingOut || undefined"
      data-testid="sign-out"
      @click="signOut"
    >
      <StaffIcon name="logout" :size="16" />
    </button>
  </div>
</template>

<style scoped>
/* Colours come from the dark sidebar tokens (--side-*): the block only lives in the sidebar. */
.user {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.user__avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--side-line);
  color: var(--side-strong);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.user__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.user__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--side-strong);
}

.user__role {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-group);
  color: var(--side-muted);
}

.user__signout {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--side-dim);
  cursor: pointer;
}

.user__signout:hover {
  background: var(--side-hover);
  color: var(--side-strong);
}

.user__signout:focus-visible {
  outline: 2px solid var(--side-icon-active);
  outline-offset: 1px;
}

@media (pointer: coarse) {
  .user__signout {
    width: 44px;
    height: 44px;
  }
}
</style>
