export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Path template with `:param` placeholders, exactly as the api routes it. */
  readonly path: string;
}

export const route = (method: HttpMethod, path: string): RouteSpec =>
  Object.freeze({ method, path });

// The api has a test that compares this table with the Nest router in both directions, so a
// renamed or added route breaks a test instead of drifting from the web client.
export const CATALOG_ROUTES = Object.freeze({
  listProducts: route('GET', '/staff/products'),
  getProduct: route('GET', '/staff/products/:id'),
  createProduct: route('POST', '/staff/products'),
  updateProduct: route('PATCH', '/staff/products/:id'),
});

export const PRICING_ROUTES = Object.freeze({
  currentPriceList: route('GET', '/price-list/current'),
  staffCurrentPriceList: route('GET', '/staff/price-list/current'),
  listVersions: route('GET', '/staff/price-list/versions'),
  getVersion: route('GET', '/staff/price-list/versions/:id'),
  createDraft: route('POST', '/staff/price-list/drafts'),
  /** The open draft (200 staff version DTO) or 404 NOT_FOUND when none exists. */
  currentDraft: route('GET', '/staff/price-list/drafts/current'),
  updateDraft: route('PATCH', '/staff/price-list/drafts/:id'),
  upsertDraftItems: route('PUT', '/staff/price-list/drafts/:id/items'),
  removeDraftItem: route('DELETE', '/staff/price-list/drafts/:id/items/:productId'),
  discardDraft: route('DELETE', '/staff/price-list/drafts/:id'),
  publishDraft: route('POST', '/staff/price-list/drafts/:id/publish'),
  /** No drafts in the staff app: the edited changes become a new PUBLISHED version at once. */
  publishChanges: route('POST', '/staff/price-list/publish'),
  productPriceHistory: route('GET', '/staff/products/:id/price-history'),
});

export const IDENTITY_ROUTES = Object.freeze({
  /** The caller's own actor summary (any authenticated role). */
  me: route('GET', '/me'),
  /** A customer's own name + phone: entered at the first order, changed later in the profile. */
  setOwnContact: route('PUT', '/me/contact'),
  /** The hover card of a person in the staff app. */
  personCard: route('GET', '/staff/people/:id'),
  /** The same card for a name known only by its Telegram id (who added an organization). */
  personCardByTelegram: route('GET', '/staff/people/by-telegram/:telegramUserId'),
  listUsers: route('GET', '/staff/users'),
  getUser: route('GET', '/staff/users/:id'),
  updateUser: route('PATCH', '/staff/users/:id'),
  /** Idempotent: assigning a role the user already holds changes nothing. */
  assignStaffRole: route('PUT', '/staff/users/:id/roles/:role'),
  /** Idempotent: removing a role the user does not hold changes nothing. */
  removeStaffRole: route('DELETE', '/staff/users/:id/roles/:role'),
  blockUser: route('POST', '/staff/users/:id/block'),
  unblockUser: route('POST', '/staff/users/:id/unblock'),
});

export const ORGANIZATION_ROUTES = Object.freeze({
  listOrganizations: route('GET', '/staff/organizations'),
  getOrganization: route('GET', '/staff/organizations/:id'),
  /** Manager, admin [C, 2026-11-11]: a GROUP or PERSON organization plus its one-time bot link. */
  createOrganization: route('POST', '/staff/organizations'),
  /** The current invite link (no-store); url only while PENDING. */
  getOrganizationInvite: route('GET', '/staff/organizations/:id/invite'),
  /** A new invite link; the previous one stops working at once [P]. */
  regenerateOrganizationInvite: route('POST', '/staff/organizations/:id/invite'),
  updateOrganization: route('PATCH', '/staff/organizations/:id'),
  assignShopOwner: route('PUT', '/staff/organizations/:id/shop-owner'),
  /** Demotes the shop owner to SELLER (the person stays a member). */
  removeShopOwner: route('DELETE', '/staff/organizations/:id/shop-owner'),
  changeMemberRole: route('PATCH', '/staff/organizations/:id/members/:userId'),
  markMemberLeft: route('POST', '/staff/organizations/:id/members/:userId/leave'),
  /**
   * Admin only [C, owner 2026-11-13]: "delete" = archive (never a hard delete; history stays).
   * Answers the organization (`archivedAt` set). A repeat is a no-op.
   */
  archiveOrganization: route('POST', '/staff/organizations/:id/archive'),
  /** Admin only: back from the archive; it stays INACTIVE until staff activate it. */
  restoreOrganization: route('POST', '/staff/organizations/:id/restore'),
});

export const ORDER_ROUTES = Object.freeze({
  // Customer area: members of an organization. The staff order routes are in STAFF_ORDER_ROUTES of
  // the staff-only entry `@iorder/shared/staff-orders`.
  getCart: route('GET', '/cart'),
  /** Sets the quantity of one product (creating the line when missing). */
  setCartItem: route('PUT', '/cart/items/:productId'),
  removeCartItem: route('DELETE', '/cart/items/:productId'),
  /** Needs the `Idempotency-Key` header; the same key twice returns the same order. */
  submitOrder: route('POST', '/orders'),
  listOrders: route('GET', '/orders'),
  getOrder: route('GET', '/orders/:id'),
  getOrderTimeline: route('GET', '/orders/:id/timeline'),
  receiveOrder: route('POST', '/orders/:id/receive'),
  changeOrderPaymentPlan: route('PUT', '/orders/:id/payment-plan'),
});

/** Fills `:param` placeholders; values are URL-encoded. Throws if a placeholder has no value. */
export function buildPath(spec: RouteSpec, params: Readonly<Record<string, string>> = {}): string {
  return spec.path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${spec.path}`);
    return encodeURIComponent(value);
  });
}
