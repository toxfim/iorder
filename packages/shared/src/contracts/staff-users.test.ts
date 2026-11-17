import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import * as staffOrders from '../staff-orders.js';
import {
  blockUserRequestSchema,
  groupRemovalItemSchema,
  STAFF_USER_ROUTES,
} from './staff-users.js';

describe('block user request', () => {
  it('defaults to not removing anyone, also for a missing body', () => {
    expect(blockUserRequestSchema.parse(undefined)).toEqual({ removeFromGroups: false });
    expect(blockUserRequestSchema.parse({})).toEqual({ removeFromGroups: false });
    expect(blockUserRequestSchema.parse({ removeFromGroups: true })).toEqual({
      removeFromGroups: true,
    });
  });

  it('is strict: unknown keys and wrong types are rejected', () => {
    expect(blockUserRequestSchema.safeParse({ removeFromGroups: 'yes' }).success).toBe(false);
    expect(blockUserRequestSchema.safeParse({ removeFromGroups: 1 }).success).toBe(false);
    expect(blockUserRequestSchema.safeParse({ chatId: '-100123' }).success).toBe(false);
    expect(blockUserRequestSchema.safeParse({ removeFromGroups: true, x: 1 }).success).toBe(false);
    expect(blockUserRequestSchema.safeParse('true').success).toBe(false);
    expect(blockUserRequestSchema.safeParse(null).success).toBe(true);
  });

  it('refuses an unknown error code in a status item', () => {
    const item = {
      organizationId: '0197a0f0-0000-7000-8000-000000000001',
      organizationName: 'Shop',
      status: 'FAILED',
      errorCode: 'BOT_NOT_ADMIN',
      maybeBanned: false,
      requestedAt: '2026-10-22T10:00:00.000Z',
      completedAt: null,
    };
    expect(groupRemovalItemSchema.safeParse(item).success).toBe(true);
    expect(groupRemovalItemSchema.safeParse({ ...item, errorCode: 'Bad Request: x' }).success).toBe(
      false,
    );
    expect(groupRemovalItemSchema.safeParse({ ...item, chatId: '-1001' }).success).toBe(false);
  });

  it('lives in the staff entry only, never in the package barrel (customer bundle)', () => {
    expect(STAFF_USER_ROUTES.userRemovalStatus.path).toBe('/staff/users/:id/removal-status');
    for (const name of ['blockUserRequestSchema', 'groupRemovalItemSchema', 'STAFF_USER_ROUTES']) {
      expect(Object.keys(staffOrders), name).toContain(name);
      expect(Object.keys(shared), name).not.toContain(name);
    }
  });
});
