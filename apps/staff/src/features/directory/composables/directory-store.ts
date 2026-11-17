import { ref, shallowRef, type Ref } from 'vue';
import type { OrganizationRole } from '@iorder/shared';
import type { ViewState } from '@core/composables/use-async-view';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import type { DirectoryApi } from '../api/directory-api';
import type { MemberView, OrganizationView } from '../domain/directory-model';

export interface DirectoryStore {
  readonly state: Ref<ViewState>;
  readonly error: Ref<unknown>;
  readonly organizations: Readonly<Ref<readonly OrganizationView[]>>;
  readonly members: Readonly<Ref<readonly MemberView[]>>;
  load: () => Promise<void>;
  /** Forgets everything (a different person signs in) and discards any read still in flight. */
  reset: () => void;
  organization: (id: string) => OrganizationView | undefined;
  member: (id: string) => MemberView | undefined;
  membersOf: (organizationId: string) => readonly MemberView[];
  setOrganizationActive: (id: string, isActive: boolean) => Promise<OrganizationView>;
  setMemberActive: (id: string, isActive: boolean) => Promise<MemberView>;
  setMemberRole: (id: string, role: OrganizationRole) => Promise<MemberView>;
}

/** Customers and members shared by the customer screens. */
export function createDirectoryStore(
  api: DirectoryApi,
  options: { onChanged?: () => void } = {},
): DirectoryStore {
  const organizations = shallowRef<readonly OrganizationView[]>([]);
  const members = shallowRef<readonly MemberView[]>([]);
  const state = ref<ViewState>('loading');
  const error = shallowRef<unknown>(null);

  let generation = 0;

  function reset(): void {
    generation += 1;
    organizations.value = [];
    members.value = [];
    error.value = null;
    state.value = 'loading';
  }

  async function load(): Promise<void> {
    const mine = generation;
    state.value = 'loading';
    try {
      const [orgs, mems] = await Promise.all([api.listOrganizations(), api.listMembers()]);
      if (mine !== generation) return;
      organizations.value = orgs;
      members.value = mems;
      error.value = null;
      state.value = 'ready';
    } catch (caught) {
      if (mine !== generation) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  const swap = <T extends { id: string }>(list: readonly T[], next: T): T[] =>
    list.some((item) => item.id === next.id)
      ? list.map((item) => (item.id === next.id ? next : item))
      : [...list, next];

  async function change<T>(request: Promise<T>, apply: (result: T) => void): Promise<T> {
    const result = await request;
    apply(result);
    options.onChanged?.();
    return result;
  }

  return {
    state,
    error,
    organizations,
    members,
    load,
    reset,
    organization: (id) => organizations.value.find((o) => o.id === id),
    member: (id) => members.value.find((m) => m.id === id),
    membersOf: (organizationId) => members.value.filter((m) => m.organizationId === organizationId),
    setOrganizationActive: (id, isActive) =>
      change(api.setOrganizationActive(id, isActive), (o) => {
        organizations.value = swap(organizations.value, o);
      }),
    setMemberActive: (id, isActive) =>
      change(api.setMemberActive(id, isActive), (m) => {
        members.value = swap(members.value, m);
      }),
    setMemberRole: (id, role) => {
      const current = members.value.find((m) => m.id === id);
      if (!current) {
        return Promise.reject(new ApiNotFoundError('Member not found', 'NOT_FOUND'));
      }
      return change(api.setMemberRole(id, current.organizationId, role), (m) => {
        members.value = swap(members.value, m);
      });
    },
  };
}
