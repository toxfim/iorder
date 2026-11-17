import { describe, expect, it } from 'vitest';
import { AuditService } from '../../modules/audit/index.js';
import type { Tx } from './db-client.js';
import type { PrismaService } from './prisma.service.js';

const base = {
  entityType: 'TEST',
  entityId: 'e1',
  action: 'TEST',
  changes: {},
};

// These tests are checked by `tsc` (pnpm typecheck): the callbacks are never executed. If a
// guarantee below is lost, its @ts-expect-error becomes unused and the typecheck fails.

describe('audit requires a transaction (compile-time)', () => {
  it('rejects the plain PrismaService and accepts a Tx', () => {
    const audit = {} as AuditService;
    const prisma = {} as PrismaService;
    const tx = {} as Tx;

    const compileOnly = (): void => {
      // @ts-expect-error a plain client must not be accepted: the audit row must share the transaction
      void audit.record(prisma, { ...base, actorUserId: 'u1' });
      void audit.record(tx, { ...base, actorUserId: 'u1' });
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});

describe('a NULL actor is impossible for normal callers (compile-time)', () => {
  it('requires a real actor in record() and a matching system source in recordSystem()', () => {
    const audit = {} as AuditService;
    const tx = {} as Tx;

    const compileOnly = (): void => {
      // @ts-expect-error a normal audit entry needs a real actor id, not null
      void audit.record(tx, { ...base, actorUserId: null });
      // @ts-expect-error a normal audit entry cannot omit the actor
      void audit.record(tx, base);
      // @ts-expect-error system entries must name the system that acts
      void audit.recordSystem(tx, { ...base, action: 'SHEET_SYNC_X' });
      void audit.recordSystem(tx, {
        ...base,
        systemSource: 'SHEET_SYNC',
        // @ts-expect-error the action must start with the system source name
        action: 'PRODUCT_UPDATED',
      });
      void audit.recordSystem(tx, { ...base, systemSource: 'SHEET_SYNC', action: 'SHEET_SYNC_X' });
      void audit.recordSystem(tx, {
        ...base,
        systemSource: 'RATE_REFRESH',
        action: 'RATE_REFRESH_X',
      });
      const crossed = { ...base, systemSource: 'RATE_REFRESH', action: 'SHEET_SYNC_X' } as const;
      // @ts-expect-error a source cannot write another source's actions
      void audit.recordSystem(tx, crossed);
      const unknownSource = {
        ...base,
        systemSource: 'SOMETHING_ELSE',
        action: 'SOMETHING_ELSE_X',
      } as const;
      // @ts-expect-error an unknown system source is not allowed
      void audit.recordSystem(tx, unknownSource);
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});
