import type { OrganizationRole, StaffRole } from '@iorder/shared';

/**
 * Who the server says the caller is. This is display and routing input only: every endpoint
 * re-checks permissions on the server (CLAUDE.md: hiding a page is not security).
 */
export interface CurrentUser {
  readonly id: string;
  readonly displayName: string;
  readonly staffRoles: readonly StaffRole[];
  /** One person belongs to one organization for now (CLAUDE.md confirmed rules). */
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly role: OrganizationRole;
  } | null;
}

export interface DemoIdentity {
  readonly id: string;
  readonly displayName: string;
  /** Short hint shown next to the name on the demo login screen. */
  readonly staffRoles: readonly StaffRole[];
  readonly organizationRole: OrganizationRole | null;
}

export interface PasswordCredentials {
  readonly login: string;
  readonly password: string;
}

/**
 * The Telegram Login Widget callback object, passed on exactly as received: the server checks
 * the signature over these very fields, so the client must not add, drop or convert any.
 */
export type TelegramWidgetPayload = Readonly<Record<string, unknown>>;

/**
 * Contract between the UI and the identity backend. The in-memory fake (fake-auth-api.ts) offers
 * pick-a-user sign-in; the real client (features/staff-auth) offers the password and Telegram
 * widget methods. The server verifies every credential; the client never decides who someone is.
 */
export interface AuthApi {
  /** `null` when nobody is signed in. */
  getCurrentUser: () => Promise<CurrentUser | null>;
  /** Only the fake adapter offers pick-a-user sign-in. */
  signIn?: (identityId: string) => Promise<CurrentUser>;
  signInWithPassword?: (credentials: PasswordCredentials) => Promise<CurrentUser>;
  signInWithTelegramWidget?: (payload: TelegramWidgetPayload) => Promise<CurrentUser>;
  /** Ends the session on the server and forgets every local credential. */
  signOut: () => Promise<void>;
  listDemoIdentities?: () => readonly DemoIdentity[];
}
