import type { OrganizationRole, StaffOrganizationResponse, StaffRole } from '@iorder/shared';
import type {
  ActivityApi,
  ActivityEntry,
  ActivityKind,
} from '@/features/activity/api/activity-api';
import { ApiError, ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import {
  businessInstant,
  businessParts,
  shiftBusinessDays,
  systemClock,
  type Clock,
} from '@core/lib/business-clock';
import type { MemberView, OrganizationView } from '../domain/directory-model';
import type { DirectoryApi } from './directory-api';
import {
  FAKE_ACTIVITY_SEEDS,
  FAKE_BACKOFFICE_MARKER,
  FAKE_DIRECTORY_ONLY_MEMBERS,
  FAKE_DIRECTORY_ONLY_ORGANIZATIONS,
  FAKE_MEMBERS,
  FAKE_ORGANIZATIONS,
} from './fake-backoffice-fixtures';

export interface FakeBackofficeOptions {
  readonly latencyMs?: number;
  readonly clock?: Clock;
  /** Who is signed in, so the history says who did what. Read at call time. */
  readonly actor?: () => { readonly name: string; readonly roles: readonly StaffRole[] } | null;
  /** Read at call time, so the page can switch scenarios without recreating the fake. */
  readonly scenario?: () => FakeScenario;
  /**
   * The organizations fake (Tashkilotlar), so the directory shows the same organizations and
   * people the api would: its non-archived organizations and their ACTIVE members. Archiving
   * there ends the memberships and hides the organization here too.
   */
  readonly linked?: LinkedOrganizations;
}

export interface LinkedOrganizations {
  /** The organizations fake's current state (members included), archived ones too. */
  readonly snapshot: () => readonly StaffOrganizationResponse[];
  readonly setStatus: (
    organizationId: string,
    status: 'ACTIVE' | 'INACTIVE',
  ) => Promise<StaffOrganizationResponse>;
}

export interface FakeBackoffice {
  readonly directoryApi: DirectoryApi;
  readonly activityApi: ActivityApi;
  /** Appends to the recent-actions feed; the fake orders backend reports its changes here. */
  readonly recordActivity: (kind: ActivityKind, params: Record<string, string>) => void;
}

/**
 * In-memory stand-in for the customers, staff and audit endpoints (the orders have their own
 * fake in features/staff-orders). Every change appends to the activity feed.
 */
export function createFakeBackoffice(options: FakeBackofficeOptions = {}): FakeBackoffice {
  const clock = options.clock ?? systemClock;
  const latencyMs = options.latencyMs ?? 0;
  let counter = 0;

  const organizations = new Map<string, OrganizationView>(
    [...FAKE_ORGANIZATIONS, ...FAKE_DIRECTORY_ONLY_ORGANIZATIONS].map((o) => [o.id, o]),
  );
  const members = new Map<string, MemberView>(
    [...FAKE_MEMBERS, ...FAKE_DIRECTORY_ONLY_MEMBERS].map((m) => [m.id, m]),
  );
  const activity: ActivityEntry[] = [];

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  // Read calls honour the dev scenario (`?state=`); writes always behave normally.
  async function beforeRead(): Promise<'empty' | null> {
    const current = options.scenario?.() ?? 'ready';
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_BACKOFFICE_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function wallTime(daysAgo: number, time: string): string {
    const [hour = '0', minute = '0'] = time.split(':');
    const day = businessParts(shiftBusinessDays(clock.now(), daysAgo));
    return businessInstant(day, Number(hour), Number(minute)).toISOString();
  }

  function record(kind: ActivityKind, params: Record<string, string>, at?: string): void {
    counter += 1;
    activity.unshift({ id: `a-${counter}`, at: at ?? clock.now().toISOString(), kind, params });
  }

  // Seeded oldest first so unshift leaves the newest on top.
  for (const seed of [...FAKE_ACTIVITY_SEEDS].reverse()) {
    record(seed.kind, { ...seed.params }, wallTime(0, seed.time));
  }

  // --- the linked organizations fake (same mapping as the http adapter) -------------------------

  // A blocked linked person: the organizations fake has no person status of its own.
  const linkedBlocked = new Set<string>();
  const linkedRoles = new Map<string, OrganizationRole>();
  const toView = (o: StaffOrganizationResponse): OrganizationView => ({
    id: o.id,
    name: o.name,
    type: o.type,
    address: '',
    phone: o.phone ?? '',
    telegramGroup: o.telegramChatId ?? '',
    isActive: o.status === 'ACTIVE',
    since: o.createdAt,
  });
  function linkedOrganizations(): OrganizationView[] {
    return (options.linked?.snapshot() ?? []).filter((o) => o.archivedAt === null).map(toView);
  }
  function linkedMembers(): MemberView[] {
    return (options.linked?.snapshot() ?? [])
      .filter((o) => o.archivedAt === null)
      .flatMap((o) =>
        o.members
          .filter((m) => m.status === 'ACTIVE')
          .map((m) => ({
            id: m.userId,
            organizationId: o.id,
            name: m.fullName,
            phone: m.phone ?? '',
            telegramUsername: '',
            role: linkedRoles.get(m.userId) ?? m.role,
            isActive: !linkedBlocked.has(m.userId),
            joinedAt: m.joinedAt,
          })),
      );
  }

  function requireOrganization(id: string): OrganizationView {
    const found = organizations.get(id) ?? linkedOrganizations().find((o) => o.id === id);
    if (!found) throw new ApiNotFoundError('Organization not found', 'NOT_FOUND');
    return found;
  }
  function requireMember(id: string): MemberView {
    const found = members.get(id) ?? linkedMembers().find((m) => m.id === id);
    if (!found) throw new ApiNotFoundError('Member not found', 'NOT_FOUND');
    return found;
  }
  const isLinkedMember = (id: string): boolean => !members.has(id);

  const directoryApi: DirectoryApi = {
    async listOrganizations() {
      const state = await beforeRead();
      return state === 'empty' ? [] : [...organizations.values(), ...linkedOrganizations()];
    },
    async listMembers() {
      const state = await beforeRead();
      return state === 'empty' ? [] : [...members.values(), ...linkedMembers()];
    },

    async setOrganizationActive(organizationId, isActive) {
      await delay();
      const org = requireOrganization(organizationId);
      if (!organizations.has(org.id) && options.linked) {
        const updated = toView(
          await options.linked.setStatus(org.id, isActive ? 'ACTIVE' : 'INACTIVE'),
        );
        record(isActive ? 'ORGANIZATION_ACTIVATED' : 'ORGANIZATION_BLOCKED', { name: org.name });
        return updated;
      }
      const next = { ...org, isActive };
      organizations.set(org.id, next);
      record(isActive ? 'ORGANIZATION_ACTIVATED' : 'ORGANIZATION_BLOCKED', { name: org.name });
      return next;
    },

    async setMemberActive(memberId, isActive) {
      await delay();
      const member = requireMember(memberId);
      const next = { ...member, isActive };
      if (isLinkedMember(member.id)) {
        if (isActive) linkedBlocked.delete(member.id);
        else linkedBlocked.add(member.id);
      } else members.set(member.id, next);
      record(isActive ? 'MEMBER_ACTIVATED' : 'MEMBER_BLOCKED', { name: member.name });
      return next;
    },

    async setMemberRole(memberId, organizationId, role: OrganizationRole) {
      await delay();
      const member = requireMember(memberId);
      if (member.organizationId !== organizationId) {
        throw new ApiNotFoundError('Member not found', 'NOT_FOUND');
      }
      const next = { ...member, role };
      if (isLinkedMember(member.id)) linkedRoles.set(member.id, role);
      else members.set(member.id, next);
      record('MEMBER_ROLE_CHANGED', { name: member.name, role });
      return next;
    },
  };

  const activityApi: ActivityApi = {
    async listRecent(limit) {
      const state = await beforeRead();
      return state === 'empty' ? [] : activity.slice(0, limit);
    },
  };

  return { directoryApi, activityApi, recordActivity: (kind, params) => record(kind, params) };
}
