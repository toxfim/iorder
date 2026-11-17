import type { OrdersNavChild } from './nav-config';

/** The order page belongs to the Orders group, but to none of its children. */
const ORDER_DETAIL_ROUTE = 'staff-order';

export interface OrdersNavRoute {
  readonly name: string | null;
  /** Filters of the orders list as parsed from the URL. */
  readonly stage: string | null;
  readonly period: string | null;
}

function matchesQuery(child: OrdersNavChild, route: OrdersNavRoute): boolean {
  // The same rule the old "awaiting approval" quick filter used: the stage on its own, without
  // the "today" / "debt" period narrowing it further.
  if (child.query?.stage !== undefined) {
    return route.stage === child.query.stage && route.period === null;
  }
  return true;
}

/**
 * The child that is highlighted, or null. "All orders" gives way to a filtered sibling, so only
 * one child is ever current. The order page highlights none (the group only).
 */
export function activeOrdersChild(
  children: readonly OrdersNavChild[],
  route: OrdersNavRoute,
): OrdersNavChild | null {
  const here = children.filter((child) => child.routeName === route.name);
  const filtered = here.find((child) => child.query !== undefined && matchesQuery(child, route));
  if (filtered) return filtered;
  return here.find((child) => child.query === undefined) ?? null;
}

export function isOrdersGroupActive(
  children: readonly OrdersNavChild[],
  routeName: string | null,
): boolean {
  return (
    routeName === ORDER_DETAIL_ROUTE || children.some((child) => child.routeName === routeName)
  );
}
