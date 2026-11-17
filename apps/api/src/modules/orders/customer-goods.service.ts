import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { uuidSchema, type CustomerGoodsQuery } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { Clock } from '../../common/clock/clock.js';
import {
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import {
  CustomerGoodsRepository,
  toSearch,
  type GoodsGroupRecord,
  type GoodsPosition,
  type GoodsUnitRecord,
} from './customer-goods.repository.js';

export interface GoodsSummaryView {
  productCount: number;
  unitCount: number;
  discoveryPending: boolean;
}

export interface GoodsListView {
  groups: GoodsGroupRecord[];
  nextCursor: string | null;
}

export interface GoodsProductView {
  group: GoodsGroupRecord;
  units: GoodsUnitRecord[];
  nextCursor: string | null;
}

/**
 * My Products ([C] 2026-10-25): the history of goods received by the caller's OWN organization
 * (orders RECEIVED), grouped by product. Not stock: nothing is inferred after resale. The
 * organization always comes from the authenticated membership, never from the request; a foreign
 * product, unit or code answers exactly like a missing one.
 */
@Injectable()
export class CustomerGoodsService {
  constructor(
    private readonly repository: CustomerGoodsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async summary(actor: Actor): Promise<GoodsSummaryView> {
    if (this.hasNoOrganization(actor)) {
      return { productCount: 0, unitCount: 0, discoveryPending: false };
    }
    const organizationId = this.organizationOf(actor);
    const counts = await this.repository.summary(organizationId);
    const discoveryPending =
      counts.unitCount > 0 &&
      !(await this.repository.hasAcknowledged(actor.userId, organizationId));
    return { ...counts, discoveryPending };
  }

  async list(actor: Actor, query: CustomerGoodsQuery): Promise<GoodsListView> {
    if (this.hasNoOrganization(actor)) return { groups: [], nextCursor: null };
    const organizationId = this.organizationOf(actor);
    const scope = `list|${query.search?.trim() ?? ''}`;
    const groups = await this.repository.listGroups(organizationId, {
      search: toSearch(query.search),
      after: decodeCursor(query.cursor, scope),
      limit: query.limit + 1,
    });
    const page = groups.slice(0, query.limit);
    const last = page.at(-1);
    return {
      groups: page,
      nextCursor:
        groups.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.lastDeliveredAt, id: last.productId }, scope)
          : null,
    };
  }

  async product(
    actor: Actor,
    productId: string,
    query: CustomerGoodsQuery,
  ): Promise<GoodsProductView> {
    if (this.hasNoOrganization(actor)) throw notFound();
    const organizationId = this.organizationOf(actor);
    const group = await this.requireGroup(organizationId, productId);
    const search = toSearch(query.search);
    // A search that names the product itself keeps all of its units.
    const productMatches = search !== null && matchesProduct(group, query.search ?? '');
    const scope = `product|${productId}|${query.search?.trim() ?? ''}`;
    const units = await this.repository.listUnits(organizationId, productId, {
      search: productMatches ? null : search,
      after: decodeCursor(query.cursor, scope),
      limit: query.limit + 1,
    });
    const page = units.slice(0, query.limit);
    const last = page.at(-1);
    return {
      group,
      units: page,
      nextCursor:
        units.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.sortAt, id: last.id }, scope)
          : null,
    };
  }

  async unit(
    actor: Actor,
    productId: string,
    unitId: string,
  ): Promise<{ group: GoodsGroupRecord; unit: GoodsUnitRecord }> {
    if (this.hasNoOrganization(actor)) throw notFound();
    const organizationId = this.organizationOf(actor);
    const group = await this.requireGroup(organizationId, productId);
    if (!uuidSchema.safeParse(unitId).success) throw notFound();
    const [unit] = await this.repository.listUnits(organizationId, productId, {
      search: null,
      after: null,
      limit: 1,
      unitId,
    });
    if (unit === undefined) throw notFound();
    return { group, unit };
  }

  /**
   * The caller saw (or dismissed) the one-time introduction. Idempotent: only the first call
   * writes the row and its audit entry (no codes, no secrets in it).
   */
  async acknowledgeDiscovery(actor: Actor): Promise<void> {
    const organizationId = this.organizationOf(actor);
    await this.repository.transaction(async (tx) => {
      const now = this.clock.now();
      const written = await this.repository.insertAcknowledgement(
        tx,
        actor.userId,
        organizationId,
        now,
      );
      if (!written) return;
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: 'ORGANIZATION',
        entityId: organizationId,
        action: 'CUSTOMER_GOODS_DISCOVERY_ACKNOWLEDGED',
        changes: { goodsDiscoveryAcknowledgedAt: { from: null, to: now.toISOString() } },
      });
    });
  }

  /**
   * A staff viewer ([C] 2026-11-09) has no organization, so no received goods: the reads answer
   * empty (or "not found") WITHOUT a query, and the one write below stays refused.
   */
  private hasNoOrganization(actor: Actor): boolean {
    return isStaffViewer(actor) && can(actor, 'VIEW_RECEIVED_GOODS');
  }

  private organizationOf(actor: Actor): string {
    const organizationId = effectiveMembership(actor)?.organizationId;
    if (organizationId === undefined || !can(actor, 'VIEW_RECEIVED_GOODS')) {
      throw new ForbiddenError('Access denied');
    }
    return organizationId;
  }

  private async requireGroup(organizationId: string, productId: string): Promise<GoodsGroupRecord> {
    if (!uuidSchema.safeParse(productId).success) throw notFound();
    const [group] = await this.repository.listGroups(organizationId, {
      search: null,
      after: null,
      limit: 1,
      productId,
    });
    if (group === undefined) throw notFound();
    return group;
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Not found');
}

function matchesProduct(group: GoodsGroupRecord, search: string): boolean {
  const text = search.trim().toLowerCase();
  return group.name.toLowerCase().includes(text) || group.productCode.toLowerCase().includes(text);
}

// The cursor is opaque to the client: base64url of the last position plus a hash of the query it
// belongs to, so a cursor reused with another search or product is rejected instead of skipping.
function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('base64url').slice(0, 16);
}

function encodeCursor(position: GoodsPosition, scope: string): string {
  return Buffer.from(
    JSON.stringify({ a: position.at.toISOString(), i: position.id, s: scopeHash(scope) }),
  ).toString('base64url');
}

function decodeCursor(cursor: string | undefined, scope: string): GoodsPosition | null {
  if (cursor === undefined) return null;
  const invalid = new InputValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid;
  const { a, i, s } = parsed as Record<string, unknown>;
  if (typeof a !== 'string' || typeof i !== 'string' || s !== scopeHash(scope)) throw invalid;
  const at = new Date(a);
  if (Number.isNaN(at.getTime()) || !uuidSchema.safeParse(i).success) throw invalid;
  return { at, id: i };
}
