import { Injectable } from '@nestjs/common';
import type { UnitCodeKind } from '@iorder/shared/staff-orders';
import type { Tx } from '../../common/database/db-client.js';
import { escapeLike } from '../../common/database/like.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface GoodsGroupRecord {
  productId: string;
  productCode: string;
  name: string;
  unitCount: number;
  codeCount: number;
  codeKinds: UnitCodeKind[];
  lastDeliveredAt: Date;
}

export interface GoodsUnitRecord {
  id: string;
  productId: string;
  unitNo: number;
  orderId: string;
  orderNumber: string;
  orderedAt: Date;
  confirmedAt: Date | null;
  deliveredAt: Date | null;
  receivedAt: Date | null;
  sortAt: Date;
  codes: { kind: UnitCodeKind; slot: number; value: string }[];
}

export interface GoodsPosition {
  at: Date;
  id: string;
}

/** Search as the SQL uses it: a LIKE pattern on names/codes and an exact normalised code key. */
export interface GoodsSearch {
  like: string;
  codeKey: string;
}

// The received goods of ONE organization (hard rule 6: the organization is part of every query).
// A unit is "received" when its order is RECEIVED ([C] 2026-10-25). Milestones are the first
// event that reached each status, never updated_at.
function receivedUnits(organizationId: string): Prisma.Sql {
  return Prisma.sql`
    received AS (
      SELECT o.id AS order_id, o.order_number, o.submitted_at,
        (SELECT min(e.created_at) FROM order_events e
          WHERE e.order_id = o.id AND e.to_status = 'MANAGER_APPROVED') AS confirmed_at,
        (SELECT min(e.created_at) FROM order_events e
          WHERE e.order_id = o.id AND e.to_status = 'DELIVERED') AS delivered_at,
        (SELECT min(e.created_at) FROM order_events e
          WHERE e.order_id = o.id AND e.to_status = 'RECEIVED') AS received_at
      FROM orders o
      WHERE o.organization_id = ${organizationId}::uuid AND o.status = 'RECEIVED'
    ),
    units AS (
      SELECT u.id, u.product_id, u.unit_no, u.order_id, r.order_number, r.submitted_at,
        r.confirmed_at, r.delivered_at, r.received_at,
        COALESCE(r.delivered_at, r.received_at, r.submitted_at) AS sort_at,
        i.name_snapshot, i.product_code_snapshot
      FROM order_units u
      JOIN received r ON r.order_id = u.order_id
      JOIN order_items i ON i.id = u.order_item_id
    )`;
}

/** Units whose product name / code or one of whose live codes matches. */
function unitMatches(search: GoodsSearch): Prisma.Sql {
  return Prisma.sql`(
    un.name_snapshot ILIKE ${search.like} OR un.product_code_snapshot ILIKE ${search.like}
    OR EXISTS (
      SELECT 1 FROM unit_codes c
      WHERE c.unit_id = un.id AND c.voided_at IS NULL
        AND (c.code_value ILIKE ${search.like} OR c.code_key = ${search.codeKey})
    )
  )`;
}

@Injectable()
export class CustomerGoodsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  async summary(organizationId: string): Promise<{ productCount: number; unitCount: number }> {
    const rows = await this.prisma.$queryRaw<{ product_count: bigint; unit_count: bigint }[]>`
      WITH ${receivedUnits(organizationId)}
      SELECT count(DISTINCT product_id) AS product_count, count(*) AS unit_count FROM units`;
    const row = rows[0];
    return {
      productCount: Number(row?.product_count ?? 0),
      unitCount: Number(row?.unit_count ?? 0),
    };
  }

  /** Product groups (grouped BEFORE pagination), newest delivery first, productId tie-break. */
  async listGroups(
    organizationId: string,
    options: {
      search: GoodsSearch | null;
      after: GoodsPosition | null;
      limit: number;
      productId?: string;
    },
  ): Promise<GoodsGroupRecord[]> {
    const matching =
      options.search === null
        ? Prisma.empty
        : Prisma.sql`AND g.product_id IN (SELECT un.product_id FROM units un WHERE ${unitMatches(options.search)})`;
    const after =
      options.after === null
        ? Prisma.empty
        : Prisma.sql`AND (g.last_delivered_at, g.product_id) < (${options.after.at}, ${options.after.id}::uuid)`;
    const only =
      options.productId === undefined
        ? Prisma.empty
        : Prisma.sql`AND g.product_id = ${options.productId}::uuid`;
    const rows = await this.prisma.$queryRaw<
      {
        product_id: string;
        product_code: string;
        name: string;
        unit_count: bigint;
        code_count: bigint;
        code_kinds: UnitCodeKind[];
        last_delivered_at: Date;
      }[]
    >`
      WITH ${receivedUnits(organizationId)},
      groups AS (
        SELECT un.product_id,
          (array_agg(un.product_code_snapshot ORDER BY un.sort_at DESC, un.id DESC))[1] AS product_code,
          (array_agg(un.name_snapshot ORDER BY un.sort_at DESC, un.id DESC))[1] AS name,
          count(DISTINCT un.id) AS unit_count,
          count(c.id) AS code_count,
          COALESCE(array_agg(DISTINCT c.kind::text) FILTER (WHERE c.id IS NOT NULL), '{}') AS code_kinds,
          max(un.sort_at) AS last_delivered_at
        FROM units un
        LEFT JOIN unit_codes c ON c.unit_id = un.id AND c.voided_at IS NULL
        GROUP BY un.product_id
      )
      SELECT g.* FROM groups g
      WHERE true ${matching} ${after} ${only}
      ORDER BY g.last_delivered_at DESC, g.product_id DESC
      LIMIT ${options.limit}`;
    return rows.map((row) => ({
      productId: row.product_id,
      productCode: row.product_code,
      name: row.name,
      unitCount: Number(row.unit_count),
      codeCount: Number(row.code_count),
      codeKinds: [...row.code_kinds].sort(),
      lastDeliveredAt: row.last_delivered_at,
    }));
  }

  /**
   * Units of one product of the organization, newest delivery first, unit id tie-break. A search
   * that matches the product's name or code keeps every unit; otherwise only the units whose codes
   * match.
   */
  async listUnits(
    organizationId: string,
    productId: string,
    options: {
      search: GoodsSearch | null;
      after: GoodsPosition | null;
      limit: number;
      unitId?: string;
    },
  ): Promise<GoodsUnitRecord[]> {
    const matching =
      options.search === null ? Prisma.empty : Prisma.sql`AND ${unitMatches(options.search)}`;
    const after =
      options.after === null
        ? Prisma.empty
        : Prisma.sql`AND (un.sort_at, un.id) < (${options.after.at}, ${options.after.id}::uuid)`;
    const only =
      options.unitId === undefined ? Prisma.empty : Prisma.sql`AND un.id = ${options.unitId}::uuid`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        product_id: string;
        unit_no: number;
        order_id: string;
        order_number: string;
        submitted_at: Date;
        confirmed_at: Date | null;
        delivered_at: Date | null;
        received_at: Date | null;
        sort_at: Date;
      }[]
    >`
      WITH ${receivedUnits(organizationId)}
      SELECT un.id, un.product_id, un.unit_no, un.order_id, un.order_number, un.submitted_at,
        un.confirmed_at, un.delivered_at, un.received_at, un.sort_at
      FROM units un
      WHERE un.product_id = ${productId}::uuid ${matching} ${after} ${only}
      ORDER BY un.sort_at DESC, un.id DESC
      LIMIT ${options.limit}`;
    if (rows.length === 0) return [];
    const codes = await this.prisma.unitCode.findMany({
      where: { unitId: { in: rows.map((row) => row.id) }, voidedAt: null },
      orderBy: [{ kind: 'asc' }, { slot: 'asc' }],
      select: { unitId: true, kind: true, slot: true, codeValue: true },
    });
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      unitNo: row.unit_no,
      orderId: row.order_id,
      orderNumber: row.order_number,
      orderedAt: row.submitted_at,
      confirmedAt: row.confirmed_at,
      deliveredAt: row.delivered_at,
      receivedAt: row.received_at,
      sortAt: row.sort_at,
      codes: codes
        .filter((code) => code.unitId === row.id)
        .map((code) => ({ kind: code.kind, slot: code.slot, value: code.codeValue })),
    }));
  }

  async hasAcknowledged(userId: string, organizationId: string): Promise<boolean> {
    const row = await this.prisma.customerGoodsDiscoveryAck.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { userId: true },
    });
    return row !== null;
  }

  /** True when this call wrote the row (a repeated acknowledgement writes nothing). */
  async insertAcknowledgement(
    tx: Tx,
    userId: string,
    organizationId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.customerGoodsDiscoveryAck.createMany({
      data: [{ userId, organizationId, acknowledgedAt: now }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }
}

export function toSearch(raw: string | undefined): GoodsSearch | null {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  return {
    like: `%${escapeLike(text)}%`,
    // IMEI digits and serials are stored without spaces (serials upper-case).
    codeKey: text.replace(/\s/g, '').toUpperCase(),
  };
}
