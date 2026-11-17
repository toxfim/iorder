import {
  DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS,
  createOrganizationRequestSchema,
  priceTierOfLabel,
  updateOrganizationRequestSchema,
  type StaffMemberResponse,
  type StaffOrganizationInviteResponse,
  type StaffOrganizationResponse,
  type StaffRole,
} from '@iorder/shared';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { canViewOrganizations } from '@/features/staff-shell/organizations-access';
import type { OrganizationsApi, OrganizationStatus } from './organizations-api';

export const FAKE_ORGANIZATIONS_MARKER = 'iorder-fake-organizations';

/** The demo bot of the fake invite links (check:bundle keeps the name out of a production build). */
const FAKE_BOT = 'iorder_demo_bot';

export interface FakeOrganizationsOptions {
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly roles?: () => readonly StaffRole[];
  readonly now?: () => Date;
}

const member = (
  key: string,
  fullName: string,
  phone: string | null,
  role: StaffMemberResponse['role'],
  joinedAt: string,
  leftAt: string | null = null,
): StaffMemberResponse => ({
  userId: fakeUuid(`org-member:${key}`),
  fullName,
  phone,
  role,
  status: leftAt === null ? 'ACTIVE' : 'LEFT',
  joinedAt,
  leftAt,
});

// Mirrors the api: the list is by name, a bot-created group starts INACTIVE with `addedBy`, a
// staff-created one has none. A staff-created organization without a chat yet is INACTIVE with an
// invite (PENDING or EXPIRED). Names are made up (not real customers).
function fixtures(now: Date): StaffOrganizationResponse[] {
  const base = {
    type: 'GROUP',
    label: 'STANDARD',
    priceTier: 'STANDARD',
    phone: null,
    invite: { status: 'LINKED', expiresAt: null },
    boundPerson: null,
    typeChangeable: false,
    pricePostingEnabled: false,
    shopOwner: null,
    addedBy: null,
    archivedAt: null,
    createdAt: '2026-08-02T06:00:00.000Z',
    updatedAt: '2026-08-02T06:00:00.000Z',
  } as const;
  const hours = (count: number): string =>
    new Date(now.getTime() + count * 3_600_000).toISOString();
  const karimov = member(
    'k1',
    'Alisher Karimov',
    '+998935551020',
    'SHOP_OWNER',
    '2026-10-08T09:21:00.000Z',
  );
  const list: StaffOrganizationResponse[] = [
    {
      ...base,
      id: fakeUuid('org:chilonzor'),
      name: 'Chilonzor Gadget',
      telegramChatId: '-1002001000011',
      status: 'ACTIVE',
      pricePostingEnabled: true,
      members: [
        member('c1', 'Dilshod Rakhimov', '+998901112233', 'SHOP_OWNER', '2026-08-02T06:10:00.000Z'),
        member('c2', 'Feruza Nazarova', '+998935556677', 'SELLER', '2026-08-03T07:30:00.000Z'),
        member(
          'c3',
          'Ulugbek Sodiqov',
          null,
          'SELLER',
          '2026-08-03T08:00:00.000Z',
          '2026-09-01T09:00:00.000Z',
        ),
      ],
      activeMemberCount: 0,
    },
    {
      ...base,
      id: fakeUuid('org:navoiy'),
      name: 'Navoiy Elektronika',
      telegramChatId: '-1002001000022',
      status: 'INACTIVE',
      addedBy: { telegramUserId: '700100200', name: 'Shaxzod Aminov' },
      createdAt: '2026-10-20T10:15:00.000Z',
      updatedAt: '2026-10-20T10:15:00.000Z',
      members: [
        member('n1', 'Shaxzod Aminov', '+998977001122', 'SELLER', '2026-10-20T10:15:00.000Z'),
        member('n2', 'Zarina Tursunova', null, 'SELLER', '2026-10-20T10:20:00.000Z'),
      ],
      activeMemberCount: 0,
    },
    {
      ...base,
      id: fakeUuid('org:buxoro'),
      name: 'Buxoro Mobil Savdo',
      telegramChatId: '-1002001000033',
      status: 'INACTIVE',
      addedBy: { telegramUserId: '700100300', name: 'Odil' },
      createdAt: '2026-10-21T03:40:00.000Z',
      updatedAt: '2026-10-21T03:40:00.000Z',
      members: [],
      activeMemberCount: 0,
    },
    {
      ...base,
      id: fakeUuid('org:andijon'),
      name: 'Andijon Telecom',
      label: 'WHOLESALE',
      priceTier: 'WHOLESALE_PARTNER',
      telegramChatId: '-1002001000044',
      status: 'ACTIVE',
      pricePostingEnabled: true,
      members: [
        member('a1', 'Bobur Karimov', '+998909998877', 'SHOP_OWNER', '2026-07-12T05:00:00.000Z'),
      ],
      activeMemberCount: 0,
    },
    {
      ...base,
      id: fakeUuid('org:qarshi'),
      name: 'Qarshi Aksessuar',
      label: 'PARTNER',
      priceTier: 'WHOLESALE_PARTNER',
      telegramChatId: '-1002001000055',
      status: 'INACTIVE',
      addedBy: null,
      updatedAt: '2026-09-15T11:00:00.000Z',
      members: [
        member('q1', 'Laylo Ergasheva', '+998941234567', 'SELLER', '2026-08-05T06:00:00.000Z'),
      ],
      activeMemberCount: 0,
    },
    // A PERSON bound through their invite: the private chat id is their Telegram user id.
    {
      ...base,
      id: fakeUuid('org:karimov'),
      name: 'Alisher Karimov',
      type: 'PERSON',
      label: 'PARTNER',
      priceTier: 'WHOLESALE_PARTNER',
      phone: '+998935551020',
      telegramChatId: '700100500',
      status: 'ACTIVE',
      pricePostingEnabled: true,
      boundPerson: {
        userId: karimov.userId,
        fullName: karimov.fullName,
        telegramUserId: '700100500',
      },
      createdAt: '2026-10-08T09:02:00.000Z',
      updatedAt: '2026-10-08T09:21:00.000Z',
      members: [karimov],
      activeMemberCount: 0,
    },
    // A PERSON staff created whose link was not used yet (PENDING) ...
    {
      ...base,
      id: fakeUuid('org:yusupova'),
      name: 'Dilnoza Yusupova',
      type: 'PERSON',
      phone: '+998901234567',
      telegramChatId: null,
      status: 'INACTIVE',
      pricePostingEnabled: true,
      invite: { status: 'PENDING', expiresAt: hours(6 * 24 + 23) },
      createdAt: hours(-1),
      updatedAt: hours(-1),
      members: [],
      activeMemberCount: 0,
    },
    // ... and a GROUP whose link ran out (EXPIRED): staff make a new one.
    {
      ...base,
      id: fakeUuid('org:samarqand'),
      name: 'Samarqand Savdo Markazi',
      label: 'WHOLESALE',
      priceTier: 'WHOLESALE_PARTNER',
      telegramChatId: null,
      status: 'INACTIVE',
      pricePostingEnabled: true,
      invite: { status: 'EXPIRED', expiresAt: hours(-26) },
      createdAt: hours(-8 * 24),
      updatedAt: hours(-8 * 24),
      members: [],
      activeMemberCount: 0,
    },
    // An organization the admin archived ("deleted") [C, owner 2026-11-13]: out of the default
    // list, INACTIVE, its chat released and its one member LEFT (history kept, so the type stays
    // frozen after a restore). No ACTIVE member, so no other fake knows its people.
    {
      ...base,
      id: fakeUuid('org:termiz'),
      name: 'Termiz Telefon Savdo',
      telegramChatId: null,
      status: 'INACTIVE',
      invite: { status: 'EXPIRED', expiresAt: null },
      archivedAt: '2026-10-01T07:00:00.000Z',
      updatedAt: '2026-10-01T07:00:00.000Z',
      members: [
        member(
          't1',
          'Sanjar Termiziy',
          null,
          'SHOP_OWNER',
          '2026-08-10T06:00:00.000Z',
          '2026-10-01T07:00:00.000Z',
        ),
      ],
      activeMemberCount: 0,
    },
  ];
  return list.map((org) => withDerived(org));
}

/** The people in the fake groups, so other fakes (blocking a person) know the same user ids. */
export function fakeOrganizationMemberRefs(): readonly {
  readonly userId: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly organizationId: string;
  readonly organizationName: string;
}[] {
  return fixtures(new Date()).flatMap((org) =>
    org.members
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({
        userId: m.userId,
        fullName: m.fullName,
        phone: m.phone,
        organizationId: org.id,
        organizationName: org.name,
      })),
  );
}

function withDerived(org: StaffOrganizationResponse): StaffOrganizationResponse {
  const active = org.members.filter((m) => m.status === 'ACTIVE');
  const owner = active.find((m) => m.role === 'SHOP_OWNER');
  return {
    ...org,
    priceTier: priceTierOfLabel(org.label),
    activeMemberCount: active.length,
    shopOwner: owner ? { userId: owner.userId, fullName: owner.fullName } : null,
    // The api's rule: never bound (no chat, no member history; the fake has no merged ones).
    typeChangeable:
      org.invite.status !== 'LINKED' && org.members.length === 0 && org.archivedAt === null,
  };
}

function summaryOf(org: StaffOrganizationResponse) {
  const { members: _members, ...summary } = org;
  void _members;
  return summary;
}

function validationError(issues: readonly { path: PropertyKey[]; message: string }[]) {
  return new ApiValidationError(
    'Request validation failed',
    'VALIDATION_FAILED',
    issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

/** In-memory organizations that follow the api's rules (permission, 404, no-op update, search). */
export function createFakeOrganizations(options: FakeOrganizationsOptions = {}): {
  organizationsApi: OrganizationsApi;
  /** The current state with members, for the directory fake (no permission, no latency). */
  snapshot: () => readonly StaffOrganizationResponse[];
} {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? (() => 'ready');
  const roles = options.roles ?? (() => ['MANAGER']);
  const now = options.now ?? (() => new Date());
  let store = fixtures(now());
  // organization id -> the payload of its open link (the fake keeps it to answer the same url).
  const tokens = new Map<string, string>();
  let tokenCounter = 0;

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  // The server's EDIT_CUSTOMERS: manager and admin only.
  function requireEditor(): void {
    if (!roles().some((role) => role === 'MANAGER' || role === 'ADMIN')) {
      throw new PermissionDeniedError();
    }
  }

  // The server's ARCHIVE_ORGANIZATION: the admin alone [C, owner 2026-11-13].
  function requireAdmin(): void {
    if (!roles().includes('ADMIN')) throw new PermissionDeniedError();
  }

  /** Like the api: nothing on an archived organization changes until the admin restores it. */
  function requireNotArchived(org: StaffOrganizationResponse): void {
    if (org.archivedAt !== null) {
      throw new ApiConflictError(
        'The organization is archived',
        'CONFLICT',
        undefined,
        'ORGANIZATION_ARCHIVED',
      );
    }
  }

  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (!canViewOrganizations(roles())) throw new PermissionDeniedError();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_ORGANIZATIONS_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  function find(id: string): StaffOrganizationResponse {
    const found = store.find((org) => org.id === id);
    if (!found) throw new ApiNotFoundError('Organization not found', 'NOT_FOUND');
    return found;
  }

  function save(next: StaffOrganizationResponse): StaffOrganizationResponse {
    const derived = withDerived(next);
    store = store.some((org) => org.id === derived.id)
      ? store.map((org) => (org.id === derived.id ? derived : org))
      : [...store, derived];
    return derived;
  }

  /** A link expired by the clock reads EXPIRED, like the api derives it. */
  function current(org: StaffOrganizationResponse): StaffOrganizationResponse {
    const { invite } = org;
    if (invite.status !== 'PENDING' || invite.expiresAt === null) return org;
    return Date.parse(invite.expiresAt) <= now().getTime()
      ? { ...org, invite: { ...invite, status: 'EXPIRED' } }
      : org;
  }

  function newToken(): string {
    tokenCounter += 1;
    // `org_` + 43 characters of [A-Za-z0-9_-], like the api's payload.
    return `org_${`demo${tokenCounter}`.padEnd(43, 'x')}`;
  }

  function linkOf(org: StaffOrganizationResponse): StaffOrganizationInviteResponse {
    const shown = current(org);
    const { status, expiresAt } = shown.invite;
    if (status !== 'PENDING') return { status, url: null, expiresAt: shown.invite.expiresAt };
    let token = tokens.get(org.id);
    if (token === undefined) {
      token = newToken();
      tokens.set(org.id, token);
    }
    const kind = org.type === 'GROUP' ? 'startgroup' : 'start';
    return { status, url: `https://t.me/${FAKE_BOT}?${kind}=${token}`, expiresAt };
  }

  function freshInvite(org: StaffOrganizationResponse): StaffOrganizationResponse {
    tokens.set(org.id, newToken());
    const expiresAt = new Date(
      now().getTime() + DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS * 1000,
    ).toISOString();
    return { ...org, invite: { status: 'PENDING', expiresAt } };
  }

  return {
    snapshot: () => store.map(current),
    organizationsApi: {
      async list(filter = {}) {
        if ((await beforeRead()) === 'empty') return [];
        const needle = filter.search?.trim().toLowerCase();
        const archived = filter.archived ?? false;
        return store
          .map(current)
          .filter((org) => (org.archivedAt !== null) === archived)
          .filter((org) => filter.status === undefined || org.status === filter.status)
          .filter((org) => filter.type === undefined || org.type === filter.type)
          .filter((org) => filter.label === undefined || org.label === filter.label)
          .filter((org) => !needle || org.name.toLowerCase().includes(needle))
          .map(summaryOf)
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      },
      async get(id) {
        await beforeRead();
        return current(find(id));
      },
      async setStatus(id, status: OrganizationStatus) {
        await delay();
        requireEditor();
        const found = find(id);
        requireNotArchived(found);
        // A repeat of the same status changes nothing (and keeps updatedAt), like the api.
        if (found.status === status) return current(found);
        if (status === 'ACTIVE' && found.invite.status !== 'LINKED') {
          throw new ApiConflictError(
            'The organization has no Telegram chat yet',
            'CONFLICT',
            undefined,
            'ORGANIZATION_NOT_LINKED',
          );
        }
        return current(save({ ...found, status, updatedAt: now().toISOString() }));
      },
      async update(id, change) {
        await delay();
        requireEditor();
        const parsed = updateOrganizationRequestSchema.safeParse(change);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const found = find(id);
        requireNotArchived(found);
        const body = parsed.data;
        // Like the api: only a never-bound organization (typeChangeable) changes its type.
        if (body.type !== undefined && body.type !== found.type && !found.typeChangeable) {
          throw new ApiConflictError(
            'The organization is already linked to a Telegram chat; its type cannot change',
            'CONFLICT',
            undefined,
            'ORGANIZATION_ALREADY_LINKED',
          );
        }
        // Like the api: a label change after creation is the admin's alone [C, owner 2026-11-12].
        if (
          body.label !== undefined &&
          body.label !== found.label &&
          !roles().some((role) => role === 'ADMIN')
        ) {
          throw new PermissionDeniedError();
        }
        const next = {
          ...found,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
        };
        const changed =
          next.name !== found.name ||
          next.type !== found.type ||
          next.label !== found.label ||
          next.phone !== found.phone;
        if (!changed) return current(found);
        return current(save({ ...next, updatedAt: now().toISOString() }));
      },
      async create(request) {
        await delay();
        requireEditor();
        const parsed = createOrganizationRequestSchema.safeParse(request);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const body = parsed.data;
        const stamp = now().toISOString();
        const organization = save(
          freshInvite({
            id: fakeUuid(`org:new:${store.length}:${body.name}`),
            name: body.name,
            type: body.type,
            label: body.label,
            priceTier: priceTierOfLabel(body.label),
            phone: body.phone,
            telegramChatId: null,
            status: 'INACTIVE',
            pricePostingEnabled: true,
            activeMemberCount: 0,
            shopOwner: null,
            addedBy: null,
            typeChangeable: true,
            invite: { status: 'PENDING', expiresAt: null },
            boundPerson: null,
            archivedAt: null,
            createdAt: stamp,
            updatedAt: stamp,
            members: [],
          }),
        );
        return { organization, invite: linkOf(organization) };
      },
      async getInvite(id) {
        await delay();
        requireEditor();
        return linkOf(find(id));
      },
      async regenerateInvite(id) {
        await delay();
        requireEditor();
        const found = find(id);
        requireNotArchived(found);
        if (found.invite.status === 'LINKED') {
          throw new ApiConflictError(
            'Already linked',
            'CONFLICT',
            undefined,
            'ORGANIZATION_ALREADY_LINKED',
          );
        }
        return linkOf(save(freshInvite({ ...found, updatedAt: now().toISOString() })));
      },
      async archive(id) {
        await delay();
        requireAdmin();
        const found = find(id);
        // A repeat changes nothing, like the api.
        if (found.archivedAt !== null) return current(found);
        // Like the api, in one step: INACTIVE, every ACTIVE membership LEFT, the chat released,
        // the open invite revoked (no chat and no open link reads EXPIRED).
        const stamp = now().toISOString();
        tokens.delete(id);
        return current(
          save({
            ...found,
            status: 'INACTIVE',
            telegramChatId: null,
            boundPerson: null,
            invite: { status: 'EXPIRED', expiresAt: null },
            members: found.members.map((m) =>
              m.status === 'ACTIVE' ? { ...m, status: 'LEFT', leftAt: stamp } : m,
            ),
            archivedAt: stamp,
            updatedAt: stamp,
          }),
        );
      },
      async restore(id) {
        await delay();
        requireAdmin();
        const found = find(id);
        if (found.archivedAt === null) return current(found);
        // Back INACTIVE and unlinked: staff bind it again with a new invite link.
        return current(save({ ...found, archivedAt: null, updatedAt: now().toISOString() }));
      },
    },
  };
}
