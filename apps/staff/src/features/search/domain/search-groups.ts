import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';
import type { RouteLocationRaw } from 'vue-router';
import type { MemberView, OrganizationView } from '@/features/directory/domain/directory-model';
import { initialsOf } from '@/features/directory/domain/directory-model';
import { phoneMatches } from '@core/lib/phone';
import { matchesOrderText } from '@/features/staff-orders/domain/order-filters';
import {
  isAwaitingManager,
  isClosedWithoutDelivery,
  type OrderSummary,
} from '@/features/staff-orders/domain/order-model';

export type SearchGroupKey = 'orders' | 'pending' | 'customers' | 'members' | 'products' | 'pages';

/** How an item's round icon looks: the v1 palette (accent soft, sand, plain, muted, dark). */
export type SearchIconTone = 'accent' | 'sand' | 'plain' | 'muted' | 'dark';

export interface SearchItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly tone: SearchIconTone;
  readonly to: RouteLocationRaw;
}

export interface SearchGroup {
  readonly key: SearchGroupKey;
  readonly items: readonly SearchItem[];
}

export interface SearchPage {
  readonly key: string;
  readonly label: string;
  readonly to: RouteLocationRaw;
}

/** Everything the palette may search, already limited to what the current role can open. */
export interface SearchSources {
  readonly pages: readonly SearchPage[];
  /** null when the role may not open the screen behind them (the group is skipped). */
  readonly orders: readonly OrderSummary[] | null;
  readonly organizations: readonly OrganizationView[] | null;
  readonly members: readonly MemberView[] | null;
  readonly products: readonly StaffProductDetailResponse[] | null;
}

/** Text the palette needs from i18n, passed in so this module stays pure. */
export interface SearchLabels {
  readonly pageSubtitle: string;
  readonly orderSubtitle: (order: OrderSummary) => string;
  readonly memberSubtitle: (
    member: MemberView,
    organization: OrganizationView | undefined,
  ) => string;
  readonly productTitle: (product: StaffProductDetailResponse) => string;
  readonly productSubtitle: (product: StaffProductDetailResponse) => string;
}

const LIMITS = { orders: 5, customers: 4, members: 4, products: 5 } as const;

/**
 * Groups and items for the Ctrl+K palette (v1, `cmdGroups`). With an empty query only the orders
 * waiting for the manager and the pages are offered; with a query every source is searched.
 */
export function buildSearchGroups(
  rawQuery: string,
  sources: SearchSources,
  labels: SearchLabels,
): SearchGroup[] {
  const query = rawQuery.trim().toLowerCase();
  const has = (text: string): boolean => text.toLowerCase().includes(query);
  const groups: SearchGroup[] = [];

  if (sources.orders) {
    const matched = query
      ? sources.orders.filter((o) => matchesOrderText(o, query))
      : sources.orders.filter((o) => isAwaitingManager(o) && !isClosedWithoutDelivery(o.status));
    const items = matched.slice(0, LIMITS.orders).map<SearchItem>((o) => ({
      id: `order:${o.id}`,
      title: `${o.orderNumber} · ${o.organizationName}`,
      subtitle: labels.orderSubtitle(o),
      icon: '#',
      tone: 'accent',
      to: { name: 'staff-order', params: { orderId: o.id } },
    }));
    if (items.length > 0) groups.push({ key: query ? 'orders' : 'pending', items });
  }

  if (sources.organizations && query) {
    const items = sources.organizations
      .filter((o) => has(`${o.name} ${o.telegramGroup} ${o.address}`))
      .slice(0, LIMITS.customers)
      .map<SearchItem>((o) => ({
        id: `org:${o.id}`,
        title: o.name,
        subtitle: `${o.telegramGroup} · ${o.address}`,
        icon: initialsOf(o.name),
        tone: 'sand',
        to: { name: 'staff-customer', params: { organizationId: o.id } },
      }));
    if (items.length > 0) groups.push({ key: 'customers', items });
  }

  if (sources.members && query) {
    const byId = new Map((sources.organizations ?? []).map((o) => [o.id, o]));
    const items = sources.members
      .filter((m) => has(`${m.name} ${m.telegramUsername}`) || phoneMatches(m.phone, rawQuery))
      .slice(0, LIMITS.members)
      .map<SearchItem>((m) => ({
        id: `member:${m.id}`,
        title: m.name,
        subtitle: labels.memberSubtitle(m, byId.get(m.organizationId)),
        icon: initialsOf(m.name),
        tone: 'muted',
        to: {
          name: 'staff-member',
          params: { organizationId: m.organizationId, memberId: m.id },
        },
      }));
    if (items.length > 0) groups.push({ key: 'members', items });
  }

  if (sources.products && query) {
    const items = sources.products
      .filter((p) => has(`${p.productCode} ${p.translations.map((t) => t.name).join(' ')}`))
      .slice(0, LIMITS.products)
      .map<SearchItem>((p) => ({
        id: `product:${p.id}`,
        title: labels.productTitle(p),
        subtitle: labels.productSubtitle(p),
        icon: '▦',
        tone: 'muted',
        to: { name: 'staff-prices', query: { history: p.id } },
      }));
    if (items.length > 0) groups.push({ key: 'products', items });
  }

  const pages = sources.pages
    .filter((p) => !query || has(p.label))
    .map<SearchItem>((p) => ({
      id: `page:${p.key}`,
      title: p.label,
      subtitle: labels.pageSubtitle,
      icon: '→',
      tone: 'plain',
      to: p.to,
    }));
  if (pages.length > 0) groups.push({ key: 'pages', items: pages });

  return groups;
}

export const flattenGroups = (groups: readonly SearchGroup[]): SearchItem[] =>
  groups.flatMap((g) => g.items);
