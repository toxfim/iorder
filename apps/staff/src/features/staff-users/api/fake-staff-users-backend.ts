import type { StaffRole, StaffUserResponse } from '@iorder/shared';
import {
  createStaffAccountRequestSchema,
  setStaffCredentialsRequestSchema,
  setStaffTelegramRequestSchema,
  type StaffAccountResponse,
} from '@iorder/shared/staff-auth';
import type { BlockUserResponse, GroupRemovalErrorCode } from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import {
  FAKE_MEMBERS,
  FAKE_ORGANIZATIONS,
} from '@/features/directory/api/fake-backoffice-fixtures';
import { fakeOrganizationMemberRefs } from '@/features/staff-organizations/api/fake-organizations-backend';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import type { StaffAccountsApi } from './staff-accounts-api';
import type { StaffUsersApi } from './staff-users-api';

// Sample data for the in-memory fake (dev, tests, VITE_USE_FAKE_API). It must never reach a
// production bundle: scripts/check-bundle.mjs looks for the marker and the names below.
export const FAKE_STAFF_USERS_MARKER = 'iorder-fake-staff-users';

export type FakeRemovalOutcome = 'DONE' | GroupRemovalErrorCode;

export interface FakeStaffUsersOptions {
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly roles?: () => readonly StaffRole[];
  readonly now?: () => Date;
  /** How a queued removal ends; `attempt` is 1 for the first try and grows with every retry. */
  readonly removalOutcome?: (group: {
    readonly organizationId: string;
    readonly organizationName: string;
    readonly attempt: number;
  }) => FakeRemovalOutcome;
  /** Reads of the status that still answer PENDING before a removal settles. */
  readonly pendingReads?: number;
}

interface AccountRecord extends StaffAccountResponse {
  telegramUserId: string | null;
}

interface CustomerRecord {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string | null;
  status: 'ACTIVE' | 'BLOCKED';
  groups: { organizationId: string; organizationName: string }[];
}

interface RemovalRecord {
  readonly organizationId: string;
  readonly organizationName: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  errorCode: GroupRemovalErrorCode | null;
  attempt: number;
  readsLeft: number;
  requestedAt: string;
  completedAt: string | null;
}

const ago = (days: number, from: Date): string =>
  new Date(from.getTime() - days * 86_400_000).toISOString();

function seedAccounts(now: Date): AccountRecord[] {
  const account = (
    key: string,
    fullName: string,
    login: string,
    roles: StaffRole[],
    extra: Partial<AccountRecord> = {},
  ): AccountRecord => ({
    id: fakeUuid(`staff-account:${key}`),
    fullName,
    login,
    roles,
    status: 'ACTIVE',
    hasPassword: true,
    telegramLinked: true,
    telegramUserId: String(700_000_000 + key.length * 1000 + roles.length),
    lastSignInAt: ago(1, now),
    createdAt: ago(60, now),
    ...extra,
  });
  return [
    account('admin', 'Rahmatulla Qosimov', 'admin@iorder.uz', ['ADMIN']),
    account('manager', 'Gulbahor Tojiyeva', 'manager@iorder.uz', ['MANAGER']),
    account('accountant', 'Ravshan Haydarov', 'ravshan@iorder.uz', ['ACCOUNTANT'], {
      telegramLinked: false,
      telegramUserId: null,
      lastSignInAt: null,
    }),
    account('purchasing', 'Umid Rahimov', 'umid@iorder.uz', ['PURCHASING_MANAGER']),
    account('warehouse', 'Mansur Ismoilov', 'mansur@iorder.uz', ['WAREHOUSE_MANAGER']),
    account('driver', 'Temur Boboyev', 'temur@iorder.uz', ['DRIVER'], {
      hasPassword: false,
      lastSignInAt: null,
    }),
    account('blocked-driver', 'Sardorbek Hamidov', 'sardorbek@iorder.uz', ['DRIVER'], {
      status: 'BLOCKED',
    }),
  ];
}

function seedCustomers(): CustomerRecord[] {
  const byId = new Map<string, CustomerRecord>();
  const orgName = new Map(FAKE_ORGANIZATIONS.map((o) => [o.id, o.name]));
  for (const m of FAKE_MEMBERS) {
    byId.set(m.id, {
      id: m.id,
      fullName: m.name,
      phone: null,
      status: m.isActive ? 'ACTIVE' : 'BLOCKED',
      groups: [
        { organizationId: m.organizationId, organizationName: orgName.get(m.organizationId) ?? '' },
      ],
    });
  }
  for (const ref of fakeOrganizationMemberRefs()) {
    byId.set(ref.userId, {
      id: ref.userId,
      fullName: ref.fullName,
      phone: ref.phone,
      status: 'ACTIVE',
      groups: [{ organizationId: ref.organizationId, organizationName: ref.organizationName }],
    });
  }
  return [...byId.values()];
}

// A demo group where the bot is not an administrator, so the failure and the retry can be seen.
const FAILING_DEMO_GROUP = 'Smart Zone Namangan';
const defaultOutcome: NonNullable<FakeStaffUsersOptions['removalOutcome']> = (group) =>
  group.organizationName === FAILING_DEMO_GROUP && group.attempt === 1 ? 'BOT_NOT_ADMIN' : 'DONE';

/**
 * In-memory blocking and staff accounts that follow the api's rules: manager and admin only; a
 * manager cannot touch an administrator; every staff target needs an administrator; every refusal
 * is the same 403; an unknown customer is a 404; a duplicate login or Telegram id is a 409.
 */
export function createFakeStaffUsers(options: FakeStaffUsersOptions = {}): {
  staffUsersApi: StaffUsersApi;
  staffAccountsApi: StaffAccountsApi;
} {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? (() => 'ready');
  const roles = options.roles ?? (() => ['MANAGER']);
  const now = options.now ?? (() => new Date());
  const removalOutcome = options.removalOutcome ?? defaultOutcome;
  const pendingReads = options.pendingReads ?? 1;

  const accounts = new Map(seedAccounts(now()).map((a) => [a.id, a]));
  const customers = new Map(seedCustomers().map((c) => [c.id, c]));
  const removals = new Map<string, RemovalRecord[]>();

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }
  const isAdmin = (): boolean => roles().includes('ADMIN');
  const isEditor = (): boolean => isAdmin() || roles().includes('MANAGER');
  function requireEditor(): void {
    if (!isEditor()) throw new PermissionDeniedError();
  }

  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (!isEditor() && !roles().includes('PURCHASING_MANAGER')) throw new PermissionDeniedError();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new ApiError(`${FAKE_STAFF_USERS_MARKER}: simulated failure`);
    return current === 'empty' ? 'empty' : null;
  }

  // One rule for the staff targets of every route: an administrator is touched by an administrator
  // only, and any staff account needs an administrator. All of it is the same plain 403.
  function assertMayTouchStaff(): void {
    if (!isAdmin()) throw new PermissionDeniedError();
  }

  const output = ({ telegramUserId: _telegramUserId, ...rest }: AccountRecord) => {
    void _telegramUserId;
    return rest;
  };

  function validation(error: {
    issues: readonly { path: PropertyKey[]; message: string }[];
  }): never {
    throw new ApiValidationError(
      'Validation failed',
      'VALIDATION_FAILED',
      error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  function staffUserOf(a: AccountRecord): StaffUserResponse {
    const t = now().toISOString();
    return {
      id: a.id,
      telegramUserId: a.telegramUserId,
      fullName: a.fullName,
      phone: null,
      language: 'UZ',
      status: a.status,
      staffRoles: a.roles,
      membership: null,
      createdAt: a.createdAt,
      updatedAt: t,
    };
  }

  function customerOf(c: CustomerRecord): StaffUserResponse {
    const group = c.groups[0];
    const t = now().toISOString();
    return {
      id: c.id,
      telegramUserId: '700000001',
      fullName: c.fullName,
      phone: c.phone,
      language: 'UZ',
      status: c.status,
      staffRoles: [],
      membership: group ? { ...group, role: 'SELLER', joinedAt: ago(30, now()) } : null,
      createdAt: ago(60, now()),
      updatedAt: t,
    };
  }

  function lookup(
    userId: string,
  ): { kind: 'staff'; account: AccountRecord } | { kind: 'customer'; customer: CustomerRecord } {
    const account = accounts.get(userId);
    if (account) {
      assertMayTouchStaff();
      return { kind: 'staff', account };
    }
    const customer = customers.get(userId);
    if (!customer) throw new ApiNotFoundError('User not found', 'NOT_FOUND');
    return { kind: 'customer', customer };
  }

  function settle(record: RemovalRecord, customer: CustomerRecord | undefined): void {
    const outcome = removalOutcome({
      organizationId: record.organizationId,
      organizationName: record.organizationName,
      attempt: record.attempt,
    });
    record.completedAt = now().toISOString();
    if (outcome === 'DONE') {
      record.status = 'DONE';
      record.errorCode = null;
      if (customer) {
        customer.groups = customer.groups.filter((g) => g.organizationId !== record.organizationId);
      }
    } else {
      record.status = 'FAILED';
      record.errorCode = outcome;
    }
  }

  const staffUsersApi: StaffUsersApi = {
    async blockUser(userId, { removeFromGroups }) {
      await delay();
      requireEditor();
      const target = lookup(userId);
      if (target.kind === 'staff') {
        const { account } = target;
        const lastAdmin =
          account.roles.includes('ADMIN') &&
          ![...accounts.values()].some(
            (a) => a.id !== account.id && a.status === 'ACTIVE' && a.roles.includes('ADMIN'),
          );
        if (lastAdmin)
          throw new ApiConflictError('Last administrator', 'CONFLICT', undefined, 'LAST_ADMIN');
        account.status = 'BLOCKED';
        return staffUserOf(account);
      }
      const { customer } = target;
      customer.status = 'BLOCKED';
      if (!removeFromGroups) return customerOf(customer);
      const list = removals.get(userId) ?? [];
      let queued = 0;
      let alreadyRequested = 0;
      for (const group of customer.groups) {
        // The server keeps one row per attempt, so a retry adds a row and leaves the failed one.
        const existing = list.findLast((r) => r.organizationId === group.organizationId);
        if (existing && existing.status !== 'FAILED') {
          alreadyRequested += 1;
          continue;
        }
        queued += 1;
        list.push({
          ...group,
          status: 'PENDING',
          errorCode: null,
          attempt: (existing?.attempt ?? 0) + 1,
          readsLeft: pendingReads,
          requestedAt: now().toISOString(),
          completedAt: null,
        });
      }
      removals.set(userId, list);
      const response: BlockUserResponse = {
        ...customerOf(customer),
        groupRemoval: { requested: true, queued, alreadyRequested },
      };
      return response;
    },

    async unblockUser(userId) {
      await delay();
      requireEditor();
      const target = lookup(userId);
      if (target.kind === 'staff') {
        target.account.status = 'ACTIVE';
        return staffUserOf(target.account);
      }
      target.customer.status = 'ACTIVE';
      // Waiting removals are cancelled by the server; finished ones stay as they are.
      removals.set(
        userId,
        (removals.get(userId) ?? []).filter((r) => r.status !== 'PENDING'),
      );
      return customerOf(target.customer);
    },

    async removalStatus(userId) {
      await delay();
      requireEditor();
      const target = lookup(userId);
      if (target.kind === 'staff') return [];
      const list = removals.get(userId) ?? [];
      for (const record of list) {
        if (record.status !== 'PENDING') continue;
        if (record.readsLeft > 0) record.readsLeft -= 1;
        else settle(record, target.customer);
      }
      // Newest first, like the server.
      return list.toReversed().map((r) => ({
        organizationId: r.organizationId,
        organizationName: r.organizationName,
        status: r.status,
        errorCode: r.errorCode,
        maybeBanned: r.errorCode === 'UNBAN_FAILED',
        requestedAt: r.requestedAt,
        completedAt: r.completedAt,
      }));
    },
  };

  function accountOrThrow(userId: string): AccountRecord {
    const account = accounts.get(userId);
    // A missing id answers a non-administrator exactly like an administrator's id.
    if (!account) {
      if (!isAdmin()) throw new PermissionDeniedError();
      throw new ApiNotFoundError('User not found', 'NOT_FOUND');
    }
    if (account.roles.includes('ADMIN') && !isAdmin()) throw new PermissionDeniedError();
    return account;
  }

  const staffAccountsApi: StaffAccountsApi = {
    async list() {
      if ((await beforeRead()) === 'empty') return [];
      requireEditor();
      return [...accounts.values()]
        .map(output)
        .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
    },

    async directory() {
      if ((await beforeRead()) === 'empty') return [];
      return [...accounts.values()]
        .map((a) => ({
          id: a.id,
          fullName: a.fullName,
          roles: a.roles,
          status: a.status,
          createdAt: a.createdAt,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
    },

    async create(input) {
      await delay();
      requireEditor();
      const parsed = createStaffAccountRequestSchema.safeParse(input);
      if (!parsed.success) return validation(parsed.error);
      const body = parsed.data;
      if (body.roles.includes('ADMIN') && !isAdmin()) throw new PermissionDeniedError();
      const taken = [...accounts.values()].some(
        (a) => a.login === body.login || a.telegramUserId === body.telegramUserId,
      );
      if (taken) throw new ApiConflictError('Could not create the account', 'CONFLICT');
      const created: AccountRecord = {
        id: fakeUuid(`staff-account:new:${accounts.size}:${body.login}`),
        fullName: body.fullName,
        login: body.login,
        roles: [...body.roles],
        status: 'ACTIVE',
        hasPassword: true,
        telegramLinked: true,
        telegramUserId: body.telegramUserId,
        lastSignInAt: null,
        createdAt: now().toISOString(),
      };
      accounts.set(created.id, created);
      return output(created);
    },

    async setTelegram(userId, telegramUserId) {
      await delay();
      requireEditor();
      const parsed = setStaffTelegramRequestSchema.safeParse({ telegramUserId });
      if (!parsed.success) return validation(parsed.error);
      const account = accountOrThrow(userId);
      if (
        [...accounts.values()].some((a) => a.id !== userId && a.telegramUserId === telegramUserId)
      ) {
        throw new ApiConflictError('Could not link', 'CONFLICT');
      }
      account.telegramUserId = telegramUserId;
      account.telegramLinked = true;
      return output(account);
    },

    async setCredentials(userId, input) {
      await delay();
      requireEditor();
      const parsed = setStaffCredentialsRequestSchema.safeParse(input);
      if (!parsed.success) return validation(parsed.error);
      const account = accountOrThrow(userId);
      if (parsed.data.login !== undefined) {
        const login = parsed.data.login;
        if ([...accounts.values()].some((a) => a.id !== userId && a.login === login)) {
          throw new ApiConflictError('Could not save', 'CONFLICT');
        }
        account.login = login;
      }
      if (parsed.data.password !== undefined) account.hasPassword = true;
      return {
        userId: account.id,
        login: account.login ?? '',
        passwordChangedAt: now().toISOString(),
      };
    },
  };

  return { staffUsersApi, staffAccountsApi };
}
