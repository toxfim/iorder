import type { OrganizationRole, StaffRole } from '@iorder/shared';
import { PermissionDeniedError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { AuthApi, CurrentUser, DemoIdentity } from './auth-api';

// In-memory stand-in for the identity backend. Names come from the design prototype
// (docs/private/design/v1/iOrder Prototype v2.dc.html, USERS). Replace this file's use in
// app/services.ts when the real client exists; nothing else should import it.

interface FakeAccount extends DemoIdentity {
  readonly user: CurrentUser;
}

function staff(id: string, displayName: string, role: StaffRole): FakeAccount {
  const user: CurrentUser = { id, displayName, staffRoles: [role], organization: null };
  return { id, displayName, staffRoles: user.staffRoles, organizationRole: null, user };
}

function customer(id: string, displayName: string, role: OrganizationRole): FakeAccount {
  const organization = { id: fakeUuid('org-orion-mobile'), name: 'Orion Mobile', role };
  return {
    id,
    displayName,
    staffRoles: [],
    organizationRole: role,
    user: { id, displayName, staffRoles: [], organization },
  };
}

const ACCOUNTS: readonly FakeAccount[] = [
  staff('admin', 'Sanjar Toshev', 'ADMIN'),
  staff('manager', 'Aziza Yusupova', 'MANAGER'),
  staff('accountant', 'Nodira Xasanova', 'ACCOUNTANT'),
  staff('warehouse', 'Rustam Qodirov', 'WAREHOUSE_MANAGER'),
  staff('driver', 'Bekzod Tursunov', 'DRIVER'),
  staff('purchasing', 'Umid Rahimov', 'PURCHASING_MANAGER'),
  customer('owner', 'Jasur Karimov', 'SHOP_OWNER'),
  customer('seller', 'Dilnoza Rahimova', 'SELLER'),
  // Signed in but neither staff nor in a customer group: exercises the permission-denied screen.
  {
    id: 'outsider',
    displayName: 'Guest',
    staffRoles: [],
    organizationRole: null,
    user: { id: 'outsider', displayName: 'Guest', staffRoles: [], organization: null },
  },
];

export interface FakeAuthApiOptions {
  /** Id of an account that is already signed in when the app starts. */
  readonly initialIdentityId?: string;
}

export function createFakeAuthApi(options: FakeAuthApiOptions = {}): AuthApi {
  let current: CurrentUser | null =
    ACCOUNTS.find((a) => a.id === options.initialIdentityId)?.user ?? null;

  return {
    getCurrentUser: () => Promise.resolve(current),
    signIn: (identityId) => {
      const account = ACCOUNTS.find((a) => a.id === identityId);
      if (!account) return Promise.reject(new PermissionDeniedError('Unknown identity'));
      current = account.user;
      return Promise.resolve(account.user);
    },
    signOut: () => {
      current = null;
      return Promise.resolve();
    },
    listDemoIdentities: () => ACCOUNTS,
  };
}
