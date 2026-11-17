import type { OrganizationRole } from '@iorder/shared';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import { showToast } from '@core/composables/use-toast';
import { ApiConflictError, ApiNotFoundError } from '@core/lib/api-errors';
import type { MemberView, OrganizationView } from '../domain/directory-model';

/**
 * Customer actions with their toasts. Blocking and role changes are reversible, so the
 * toast offers an undo that applies the opposite change (v1 has no undo here; it is an addition).
 */
export function useDirectoryActions() {
  const { t } = useI18n();
  const { directoryStore } = useServices();

  function errorMessage(error: unknown): string {
    if (error instanceof ApiConflictError || error instanceof ApiNotFoundError) {
      return t('directoryErrors.conflict');
    }
    return t('directoryErrors.generic');
  }

  /** Runs one action; a failure becomes a toast and `null` (the lists are re-read after a conflict). */
  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    try {
      return await action();
    } catch (caught) {
      showToast({ message: errorMessage(caught) });
      if (caught instanceof ApiConflictError || caught instanceof ApiNotFoundError) {
        void directoryStore.load();
      }
      return null;
    }
  }

  async function setOrganizationActive(
    organization: OrganizationView,
    isActive: boolean,
  ): Promise<boolean> {
    const result = await run(() => directoryStore.setOrganizationActive(organization.id, isActive));
    if (!result) return false;
    showToast({
      message: t(isActive ? 'customers.toast.activated' : 'customers.toast.blocked', {
        name: organization.name,
      }),
      undoLabel: t('common.undo'),
      onUndo: () =>
        void run(() => directoryStore.setOrganizationActive(organization.id, !isActive)),
    });
    return true;
  }

  async function setMemberActive(member: MemberView, isActive: boolean): Promise<boolean> {
    const result = await run(() => directoryStore.setMemberActive(member.id, isActive));
    if (!result) return false;
    showToast({
      message: t(isActive ? 'customers.toast.activated' : 'customers.toast.blocked', {
        name: member.name,
      }),
      undoLabel: t('common.undo'),
      onUndo: () => void run(() => directoryStore.setMemberActive(member.id, !isActive)),
    });
    return true;
  }

  async function setMemberRole(member: MemberView, role: OrganizationRole): Promise<boolean> {
    const previous = member.role;
    const result = await run(() => directoryStore.setMemberRole(member.id, role));
    if (!result) return false;
    showToast({
      message: t('customers.toast.role', {
        name: member.name,
        role: t(`roles.organization.${role}`),
      }),
      undoLabel: t('common.undo'),
      onUndo: () => void run(() => directoryStore.setMemberRole(member.id, previous)),
    });
    return true;
  }

  return {
    setOrganizationActive,
    setMemberActive,
    setMemberRole,
  };
}
