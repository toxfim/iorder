import { buildPath, type RouteSpec } from '@iorder/shared';
import { expect } from 'vitest';
import type { z } from 'zod';
import type { Actor } from '../../src/common/auth/actor.js';
import { findForbiddenKeys, findStaffOnlyFieldsInCustomerCart } from './forbidden-fields.js';
import type { World } from './orders-world.js';

export interface Reply {
  status: number;
  body: unknown;
}

export interface CallOptions {
  actor?: Actor;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  key?: string;
}

/** Calls a route of the shared table over real HTTP. */
export function caller(world: World): (route: RouteSpec, options?: CallOptions) => Promise<Reply> {
  return async (route, options = {}) => {
    const query = options.query
      ? `?${new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)]))}`
      : '';
    return world.t.request(route.method, buildPath(route, options.params) + query, {
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.key === undefined ? {} : { headers: { 'idempotency-key': options.key } }),
    });
  };
}

/** Asserts the status and parses the body with a strict shared schema (a leak fails the parse). */
export function expectParsed<TSchema extends z.ZodType>(
  reply: Reply,
  status: number,
  schema: TSchema,
): z.output<TSchema> {
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);
  const parsed = schema.safeParse(reply.body);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  return parsed.data as z.output<TSchema>;
}

/** The shared error body of a failed call, with its machine-readable parts. */
export function expectError(
  reply: Reply,
  status: number,
  code: string,
  reason?: string,
): { code: string; message: string; reason?: string; details?: unknown } {
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);
  const error = (reply.body as { error: { code: string; message: string; reason?: string } }).error;
  expect(error.code).toBe(code);
  if (reason !== undefined) expect(error.reason).toBe(reason);
  return error;
}

/** Key names that must never appear in a customer response, whatever their value. */
export const CUSTOMER_FORBIDDEN_KEYS: readonly string[] = [
  'allocations',
  'accountingMode',
  'accountingClearedAt',
  'accountingReviewedAt',
  'accountingReviewedBy',
  'accounting',
  'priceListVersionId',
  'driverUserId',
  'driver',
  'detail',
  'placedByUserId',
  'organizationId',
  'idempotencyKey',
  'dedupeKey',
  'payload',
  'notifications',
  'recipientKind',
  'recipientRole',
  'recipientUserId',
  'deliveryContact',
  'phone',
  'userId',
  // The product type is staff vocabulary [C, owner 2026-11-09]: a customer never learns that a
  // product is staff-added, outside the stock plan, or brought by order.
  'stockTracked',
  'codeGenerated',
  'sheetMatch',
  'mergedIntoProductId',
  'byOrder',
];

/**
 * A customer response is safe when: no cost-like or staff-only key (the shared scans), none of
 * the staff-only keys above, and no staff user id, price list version id or accounting marker
 * anywhere in the text (a value can leak under an innocent key).
 */
export function assertCustomerSafe(body: unknown, world: World): void {
  expect(findForbiddenKeys(body)).toEqual([]);
  // The stock figure is allowed on a cart line and on a refusal line only (owner, 2026-11-09).
  expect(findStaffOnlyFieldsInCustomerCart(body)).toEqual([]);
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(body);
  expect([...keys].filter((key) => CUSTOMER_FORBIDDEN_KEYS.includes(key))).toEqual([]);

  const text = JSON.stringify(body);
  const staffIds = [
    world.ids.manager,
    world.ids.manager2,
    world.ids.accountant,
    world.ids.warehouse,
    world.ids.driver,
    world.ids.driver2,
    world.ids.admin,
  ];
  for (const id of staffIds) expect(text).not.toContain(id);
  if (world.versionId) expect(text).not.toContain(world.versionId);
  expect(text).not.toMatch(/SKIPPED_BY_MANAGER|ACCOUNTING_SKIPPED/);
}
