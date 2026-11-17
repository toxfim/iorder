import {
  SUPPLY_PARTY_ROUTES,
  setSupplyPartyResponseSchema,
  supplyListResponseSchema,
  supplyPartyChangedDetailsSchema,
  supplyPartyConflictDetailsSchema,
  type SetSupplyPartyRequest,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule, SupplyPartyService } from '../src/modules/pricing/index.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SELLER,
  SHOP_OWNER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

// [C] 2026-10-30: the manager attaches a party number to whole supplies, and nothing is overwritten
// without having been seen.
describe('party numbers on supplies (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });

  async function addLine(deliveryRef: string, productCode: string, quantity = '5.000') {
    const product = await t.prisma.product.upsert({
      where: { productCode },
      create: {
        productCode,
        unit: 'piece',
        translations: { create: [{ lang: 'UZ', name: `Tovar ${productCode}` }] },
      },
      update: {},
    });
    return t.prisma.priceReference.create({
      data: {
        productId: product.id,
        deliveryRef,
        supplier: 'secret supplier',
        purchaseMethod: 'Import',
        category: 'Telefonlar',
        deliveredQuantity: new Prisma.Decimal(quantity),
        availableQuantity: new Prisma.Decimal(quantity),
        costUsd: new Prisma.Decimal('1.5000'),
        usdRateUsed: new Prisma.Decimal('12650.0000'),
        costUzs: new Prisma.Decimal('18975.00'),
        deliveredAt: new Date('2026-10-20T05:00:00Z'),
        syncedAt: new Date('2026-10-20T05:00:00Z'),
      },
    });
  }

  beforeEach(async () => {
    t.clock.set(new Date('2026-10-30T08:00:00Z'));
    await resetCatalogPricingAudit(t.prisma);
    await addLine('Z-1', '10001');
    await addLine('Z-1', '10002');
    await addLine('Z-2', '10003');
    await addLine('Z-3', '10004');
  });

  const put = (body: SetSupplyPartyRequest, actor = MANAGER) =>
    t.request('PUT', SUPPLY_PARTY_ROUTES.setSupplyParty.path, { actor, body });
  const list = (search?: string, actor = MANAGER) =>
    t.request(
      'GET',
      `${SUPPLY_PARTY_ROUTES.listSupplies.path}${search ? `?search=${search}` : ''}`,
      { actor },
    );

  /** What a screen that just loaded sends: the parties as they are now. */
  async function seen(refs: readonly string[]): Promise<SetSupplyPartyRequest['seenParties']> {
    const rows = await t.prisma.supplyParty.findMany({ where: { deliveryRef: { in: [...refs] } } });
    return refs.map((deliveryRef) => ({
      deliveryRef,
      partyNumber: rows.find((row) => row.deliveryRef === deliveryRef)?.partyNumber ?? null,
    }));
  }

  async function setUp(partyNumber: string, ...deliveryRefs: string[]): Promise<void> {
    const reply = await put({ deliveryRefs, partyNumber, seenParties: await seen(deliveryRefs) });
    expect(reply.status).toBe(200);
  }

  const partyOf = async (deliveryRef: string): Promise<string | null> =>
    (await t.prisma.supplyParty.findUnique({ where: { deliveryRef } }))?.partyNumber ?? null;

  const audits = () =>
    t.prisma.auditLog.findMany({
      where: { entityType: 'SUPPLY_PARTY' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  describe('the list', () => {
    it('groups live lines by supply: count, names, total, date, party; no cost, no supplier', async () => {
      await setUp('7', 'Z-1');
      const reply = await list();
      expect(reply.status).toBe(200);
      const body = supplyListResponseSchema.parse(reply.body);
      expect(body.total).toBe(3);
      const row = body.items.find((item) => item.deliveryRef === 'Z-1');
      expect(row).toMatchObject({
        productCount: 2,
        totalQuantity: '10.000',
        partyNumber: '7',
        deliveredAt: '2026-10-20T05:00:00.000Z',
      });
      expect(row?.products.map((p) => p.names[0]?.name)).toEqual(['Tovar 10001', 'Tovar 10002']);
      expect(findForbiddenKeys(reply.body as Body)).toEqual([]);
      expect(JSON.stringify(reply.body)).not.toContain('secret supplier');
    });

    it('searches by supply id and leaves removed lines out', async () => {
      await t.prisma.priceReference.updateMany({
        where: { deliveryRef: 'Z-3' },
        data: { removedAt: new Date(), removedBy: MANAGER.userId },
      });
      const all = await list();
      expect(supplyListResponseSchema.parse(all.body).items.map((i) => i.deliveryRef)).toEqual([
        'Z-1',
        'Z-2',
      ]);
      const found = await list('z-2');
      expect(supplyListResponseSchema.parse(found.body).items.map((i) => i.deliveryRef)).toEqual([
        'Z-2',
      ]);
    });
  });

  describe('setting a party', () => {
    it('sets several supplies at once, with one audit row per supply', async () => {
      const reply = await put({
        deliveryRefs: ['Z-1', 'Z-2'],
        partyNumber: '  7 ',
        seenParties: await seen(['Z-1', 'Z-2']),
      });
      expect(reply.status).toBe(200);
      expect(setSupplyPartyResponseSchema.parse(reply.body)).toEqual({
        outcome: 'CHANGED',
        partyNumber: '7',
        changed: [
          { deliveryRef: 'Z-1', from: null, to: '7' },
          { deliveryRef: 'Z-2', from: null, to: '7' },
        ],
        alreadySet: [],
        removedFromParty: [],
      });
      expect(await partyOf('Z-1')).toBe('7');
      const rows = await audits();
      expect(rows.map((row) => [row.entityId, row.action, row.actorUserId])).toEqual([
        ['Z-1', 'SUPPLY_PARTY_SET', MANAGER.userId],
        ['Z-2', 'SUPPLY_PARTY_SET', MANAGER.userId],
      ]);
      expect(rows[0]?.diff).toEqual({ partyNumber: { from: null, to: '7' } });
    });

    it.each([
      ['empty', '   '],
      ['too long', 'x'.repeat(33)],
    ])('refuses a party number that is %s', async (_name, partyNumber) => {
      const reply = await put({
        deliveryRefs: ['Z-1'],
        partyNumber,
        seenParties: await seen(['Z-1']),
      });
      expect(reply.status).toBe(422);
      expect(await audits()).toEqual([]);
    });

    it('(a) another party on a chosen supply asks first; REPLACE replaces it', async () => {
      await setUp('5', 'Z-1');
      const body = {
        deliveryRefs: ['Z-1'],
        partyNumber: '7',
        seenParties: await seen(['Z-1']),
      };
      const asked = await put(body);
      expect(asked.status).toBe(409);
      expect((asked.body as Body).error.reason).toBe('SUPPLY_PARTY_CONFLICT');
      expect(supplyPartyConflictDetailsSchema.parse((asked.body as Body).error.details)).toEqual({
        supplyConflicts: [{ deliveryRef: 'Z-1', partyNumber: '5' }],
        partyMembers: [],
      });
      expect(await partyOf('Z-1')).toBe('5');

      const done = await put({ ...body, onSupplyConflict: 'REPLACE' });
      expect(done.status).toBe(200);
      expect(await partyOf('Z-1')).toBe('7');
      expect((await audits()).at(-1)?.diff).toEqual({ partyNumber: { from: '5', to: '7' } });
    });

    it('(b) a party on other supplies asks first; ADD keeps them', async () => {
      await setUp('7', 'Z-1');
      const body = { deliveryRefs: ['Z-2'], partyNumber: '7', seenParties: await seen(['Z-2']) };
      const asked = await put(body);
      expect(asked.status).toBe(409);
      expect(supplyPartyConflictDetailsSchema.parse((asked.body as Body).error.details)).toEqual({
        supplyConflicts: [],
        partyMembers: ['Z-1'],
      });
      const done = await put({ ...body, onPartyConflict: 'ADD', seenPartyMembers: ['Z-1'] });
      expect(done.status).toBe(200);
      expect(await partyOf('Z-1')).toBe('7');
      expect(await partyOf('Z-2')).toBe('7');
    });

    it('(b) REPLACE_MEMBERS takes the party off the others, audited', async () => {
      await setUp('7', 'Z-1');
      const reply = await put({
        deliveryRefs: ['Z-2'],
        partyNumber: '7',
        seenParties: await seen(['Z-2']),
        onPartyConflict: 'REPLACE_MEMBERS',
        seenPartyMembers: ['Z-1'],
      });
      expect(reply.status).toBe(200);
      expect((reply.body as Body).removedFromParty).toEqual(['Z-1']);
      expect(await partyOf('Z-1')).toBeNull();
      expect(await partyOf('Z-2')).toBe('7');
      const removal = (await audits()).find((row) => row.action === 'SUPPLY_PARTY_REMOVED');
      expect(removal?.entityId).toBe('Z-1');
      expect(removal?.diff).toEqual({ partyNumber: { from: '7', to: null } });
    });

    it('(c) both at once: one answer without the other is still refused', async () => {
      await setUp('7', 'Z-1');
      await setUp('5', 'Z-2');
      const body = { deliveryRefs: ['Z-2'], partyNumber: '7', seenParties: await seen(['Z-2']) };
      const asked = await put(body);
      expect(supplyPartyConflictDetailsSchema.parse((asked.body as Body).error.details)).toEqual({
        supplyConflicts: [{ deliveryRef: 'Z-2', partyNumber: '5' }],
        partyMembers: ['Z-1'],
      });
      const half = await put({ ...body, onSupplyConflict: 'REPLACE' });
      expect(half.status).toBe(409);
      const otherHalf = await put({ ...body, onPartyConflict: 'ADD', seenPartyMembers: ['Z-1'] });
      expect(otherHalf.status).toBe(409);
      expect(await partyOf('Z-2')).toBe('5');
      const done = await put({
        ...body,
        onSupplyConflict: 'REPLACE',
        onPartyConflict: 'ADD',
        seenPartyMembers: ['Z-1'],
      });
      expect(done.status).toBe(200);
      expect(await partyOf('Z-2')).toBe('7');
    });

    it('(d) the same party again writes nothing, and says so', async () => {
      await setUp('7', 'Z-1');
      await setUp('8', 'Z-2');
      const before = (await audits()).length;
      const stamp = (
        await t.prisma.supplyParty.findUniqueOrThrow({
          where: { deliveryRef: 'Z-1' },
        })
      ).updatedAt;
      t.clock.set(new Date('2026-10-30T09:00:00Z'));
      const reply = await put({
        deliveryRefs: ['Z-1'],
        partyNumber: '7',
        seenParties: await seen(['Z-1']),
      });
      expect(reply.status).toBe(200);
      expect((reply.body as Body).outcome).toBe('NOTHING_TO_DO');
      expect((reply.body as Body).alreadySet).toEqual(['Z-1']);
      expect((await audits()).length).toBe(before);
      expect(
        (await t.prisma.supplyParty.findUniqueOrThrow({ where: { deliveryRef: 'Z-1' } })).updatedAt,
      ).toEqual(stamp);
    });

    it('(d) only the supplies that differ are written when some already have it', async () => {
      await setUp('7', 'Z-1');
      const before = (await audits()).length;
      const reply = await put({
        deliveryRefs: ['Z-1', 'Z-2'],
        partyNumber: '7',
        seenParties: await seen(['Z-1', 'Z-2']),
      });
      expect(reply.status).toBe(200);
      expect((reply.body as Body).alreadySet).toEqual(['Z-1']);
      expect((reply.body as Body).changed).toEqual([{ deliveryRef: 'Z-2', from: null, to: '7' }]);
      expect((await audits()).length).toBe(before + 1);
    });

    it('a party is compared exactly: 7 and 07 are two parties', async () => {
      await setUp('7', 'Z-1');
      const reply = await put({
        deliveryRefs: ['Z-2'],
        partyNumber: '07',
        seenParties: await seen(['Z-2']),
      });
      expect(reply.status).toBe(200);
    });

    it('(e) a supply removed meanwhile is refused and named', async () => {
      const body = {
        deliveryRefs: ['Z-1', 'Z-3'],
        partyNumber: '7',
        seenParties: await seen(['Z-1', 'Z-3']),
      };
      await t.prisma.priceReference.updateMany({
        where: { deliveryRef: 'Z-3' },
        data: { removedAt: new Date(), removedBy: MANAGER.userId },
      });
      const reply = await put(body);
      expect(reply.status).toBe(409);
      expect((reply.body as Body).error.reason).toBe('SUPPLY_NOT_AVAILABLE');
      expect((reply.body as Body).error.details).toEqual({ deliveryRefs: ['Z-3'] });
      expect(await partyOf('Z-1')).toBeNull();
    });

    it('(f) a change by another manager since the screen loaded is refused, with how it stands', async () => {
      const screen = await seen(['Z-1']);
      await setUp('5', 'Z-1');
      const reply = await put({
        deliveryRefs: ['Z-1'],
        partyNumber: '7',
        seenParties: screen,
        onSupplyConflict: 'REPLACE',
      });
      expect(reply.status).toBe(409);
      expect((reply.body as Body).error.reason).toBe('SUPPLY_PARTY_CHANGED');
      expect(supplyPartyChangedDetailsSchema.parse((reply.body as Body).error.details)).toEqual({
        parties: [{ deliveryRef: 'Z-1', partyNumber: '5' }],
        partyMembers: [],
      });
      expect(await partyOf('Z-1')).toBe('5');
    });

    it('(f) members that changed since the question are refused too', async () => {
      await setUp('7', 'Z-1');
      const body = { deliveryRefs: ['Z-3'], partyNumber: '7', seenParties: await seen(['Z-3']) };
      await setUp('7', 'Z-1', 'Z-2');
      const reply = await put({
        ...body,
        onPartyConflict: 'REPLACE_MEMBERS',
        seenPartyMembers: ['Z-1'],
      });
      expect(reply.status).toBe(409);
      expect((reply.body as Body).error.reason).toBe('SUPPLY_PARTY_CHANGED');
      expect(await partyOf('Z-2')).toBe('7');
    });

    it('two managers saving at once: one wins, the other is told', async () => {
      const screen = await seen(['Z-1']);
      const replies = await Promise.all([
        put({ deliveryRefs: ['Z-1'], partyNumber: '7', seenParties: screen }),
        put({ deliveryRefs: ['Z-1'], partyNumber: '8', seenParties: screen }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect((await audits()).length).toBe(1);
    });

    it('keeps the party when the sheet line of the supply is removed', async () => {
      await setUp('7', 'Z-3');
      await t.prisma.priceReference.updateMany({
        where: { deliveryRef: 'Z-3' },
        data: { removedAt: new Date(), removedBy: MANAGER.userId },
      });
      expect(await partyOf('Z-3')).toBe('7');
    });

    it('rolls the whole save back when an audit row cannot be written', async () => {
      const service = t.get(SupplyPartyService);
      const audit = (service as unknown as { audit: { record: (...args: unknown[]) => unknown } })
        .audit;
      const original = audit.record.bind(audit);
      let calls = 0;
      audit.record = (...args: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error('audit down');
        return original(...args);
      };
      try {
        const reply = await put({
          deliveryRefs: ['Z-1', 'Z-2'],
          partyNumber: '7',
          seenParties: await seen(['Z-1', 'Z-2']),
        });
        expect(reply.status).toBe(500);
      } finally {
        audit.record = original;
      }
      expect(await partyOf('Z-1')).toBeNull();
      expect(await audits()).toEqual([]);
    });

    it('reads party numbers by refs for the orders', async () => {
      await setUp('7', 'Z-1');
      const found = await t.get(SupplyPartyService).partyNumbersByRefs(['Z-1', 'Z-2']);
      expect([...found]).toEqual([['Z-1', '7']]);
    });
  });

  describe('who', () => {
    it.each([
      ['accountant', ACCOUNTANT],
      ['admin', ADMIN],
      ['warehouse', WAREHOUSE],
      ['driver', DRIVER],
      ['shop owner', SHOP_OWNER],
      ['seller', SELLER],
    ])('%s gets 403 on both routes', async (_name, who) => {
      expect((await list(undefined, who)).status).toBe(403);
      const save = await put(
        { deliveryRefs: ['Z-1'], partyNumber: '7', seenParties: await seen(['Z-1']) },
        who,
      );
      expect(save.status).toBe(403);
      expect(await partyOf('Z-1')).toBeNull();
    });
  });
});
