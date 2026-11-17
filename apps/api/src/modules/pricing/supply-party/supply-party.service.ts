import {
  SUPPLY_PRODUCT_NAMES_SHOWN,
  SUPPLY_SEARCH_LIMIT,
  type SetSupplyPartyRequest,
  type SetSupplyPartyResponse,
  type SupplySearchQuery,
} from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import { Clock } from '../../../common/clock/clock.js';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { ConflictError, ForbiddenError } from '../../../common/errors/domain-errors.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/index.js';
import { CatalogService, type ProductView } from '../../catalog/index.js';
import { SupplyPartyRepository } from './supply-party.repository.js';

export interface SupplyView {
  deliveryRef: string;
  productCount: number;
  products: ProductView[];
  totalQuantity: Prisma.Decimal;
  deliveredAt: Date;
  partyNumber: string | null;
}

const ENTITY = 'SUPPLY_PARTY';
// The lock the sync and the removal decision take: a line cannot vanish between the check and the
// write, and two managers saving at once are served one after the other.
const LOCK = 'price_reference_sync';

const sameMembers = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((ref) => set.has(ref));
};

/**
 * Party numbers on whole supplies ([C] 2026-10-30, manager only). Nothing changes without the
 * manager having seen it: another party on a chosen supply, or other supplies in this party, is a
 * 409 until answered, and what changed since the manager's screen loaded is a 409 of its own. A
 * supply's lines leaving (the sheet sync) never drops its party.
 */
@Injectable()
export class SupplyPartyService {
  constructor(
    private readonly repository: SupplyPartyRepository,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async listSupplies(
    actor: Actor,
    query: SupplySearchQuery,
  ): Promise<{ items: SupplyView[]; total: number }> {
    this.assertManager(actor);
    const groups = await this.repository.listSupplyGroups(query.search || undefined);
    const shown = groups
      .sort(
        (a, b) =>
          b.deliveredAt.getTime() - a.deliveredAt.getTime() ||
          a.deliveryRef.localeCompare(b.deliveryRef),
      )
      .slice(0, SUPPLY_SEARCH_LIMIT);
    const refs = shown.map((group) => group.deliveryRef);
    const [lines, parties] = await Promise.all([
      this.repository.findLineProducts(refs),
      this.partyNumbersByRefs(refs),
    ]);
    const products = await this.catalog.findProductsByIds([
      ...new Set(lines.map((line) => line.productId)),
    ]);
    const productById = new Map(products.map((product) => [product.id, product]));
    const productsOf = (ref: string): ProductView[] =>
      lines
        .filter((line) => line.deliveryRef === ref)
        .flatMap((line) => productById.get(line.productId) ?? [])
        .sort((a, b) => a.productCode.localeCompare(b.productCode))
        .slice(0, SUPPLY_PRODUCT_NAMES_SHOWN);
    return {
      total: groups.length,
      items: shown.map((group) => ({
        ...group,
        products: productsOf(group.deliveryRef),
        partyNumber: parties.get(group.deliveryRef) ?? null,
      })),
    };
  }

  /** The party of each supply that has one (orders read it live). The caller authorizes. */
  async partyNumbersByRefs(refs: readonly string[], db?: DbClient): Promise<Map<string, string>> {
    const rows = await this.repository.findParties(refs, db);
    return new Map(rows.map((row) => [row.deliveryRef, row.partyNumber]));
  }

  /** `request` passed the contract's schema in the controller (the party number is trimmed). */
  async setParty(actor: Actor, request: SetSupplyPartyRequest): Promise<SetSupplyPartyResponse> {
    this.assertManager(actor);
    const { deliveryRefs, partyNumber } = request;
    const chosen = new Set(deliveryRefs);
    return this.repository.transaction(async (tx) => {
      await this.repository.lockNamed(tx, LOCK);

      const live = await this.repository.findLiveRefs(tx, deliveryRefs);
      const gone = deliveryRefs.filter((ref) => !live.has(ref));
      if (gone.length > 0) {
        throw new ConflictError('A chosen supply no longer exists', 'SUPPLY_NOT_AVAILABLE', {
          deliveryRefs: gone,
        });
      }

      const current = await this.partyNumbersByRefs(deliveryRefs, tx);
      const members = (await this.repository.findMembers(tx, partyNumber))
        .map((row) => row.deliveryRef)
        .filter((ref) => !chosen.has(ref));

      const changedUnderfoot =
        request.seenParties.some(
          (seen) => (current.get(seen.deliveryRef) ?? null) !== seen.partyNumber,
        ) ||
        (request.seenPartyMembers !== undefined && !sameMembers(request.seenPartyMembers, members));
      if (changedUnderfoot) {
        throw new ConflictError('Another manager changed this', 'SUPPLY_PARTY_CHANGED', {
          parties: deliveryRefs.map((deliveryRef) => ({
            deliveryRef,
            partyNumber: current.get(deliveryRef) ?? null,
          })),
          partyMembers: members,
        });
      }

      const alreadySet = deliveryRefs.filter((ref) => current.get(ref) === partyNumber);
      const toSet = deliveryRefs.filter((ref) => current.get(ref) !== partyNumber);
      const replacing = request.onPartyConflict === 'REPLACE_MEMBERS';
      if (toSet.length === 0 && !(replacing && members.length > 0)) {
        return {
          outcome: 'NOTHING_TO_DO' as const,
          partyNumber,
          changed: [],
          alreadySet,
          removedFromParty: [],
        };
      }

      const supplyConflicts = toSet.flatMap((deliveryRef) => {
        const party = current.get(deliveryRef);
        return party === undefined ? [] : [{ deliveryRef, partyNumber: party }];
      });
      const unansweredSupply = supplyConflicts.length > 0 && request.onSupplyConflict !== 'REPLACE';
      const unansweredParty = members.length > 0 && request.onPartyConflict === undefined;
      if (unansweredSupply || unansweredParty) {
        throw new ConflictError('The manager has to decide first', 'SUPPLY_PARTY_CONFLICT', {
          supplyConflicts,
          partyMembers: members,
        });
      }

      const now = this.clock.now();
      const changed: SetSupplyPartyResponse['changed'] = [];
      for (const deliveryRef of toSet) {
        const from = current.get(deliveryRef) ?? null;
        await this.repository.setParty(tx, deliveryRef, partyNumber, actor.userId, now);
        await this.recordChange(tx, actor, deliveryRef, from, partyNumber);
        changed.push({ deliveryRef, from, to: partyNumber });
      }
      const removedFromParty = replacing ? members : [];
      if (removedFromParty.length > 0) {
        await this.repository.removeParties(tx, removedFromParty);
        for (const deliveryRef of removedFromParty) {
          await this.recordChange(tx, actor, deliveryRef, partyNumber, null);
        }
      }
      return {
        outcome: 'CHANGED' as const,
        partyNumber,
        changed,
        alreadySet,
        removedFromParty,
      };
    });
  }

  private recordChange(
    tx: Tx,
    actor: Actor,
    deliveryRef: string,
    from: string | null,
    to: string | null,
  ): Promise<void> {
    return this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: ENTITY,
      entityId: deliveryRef,
      action: to === null ? 'SUPPLY_PARTY_REMOVED' : 'SUPPLY_PARTY_SET',
      changes: { partyNumber: { from, to } },
    });
  }

  private assertManager(actor: Actor): void {
    if (!can(actor, 'SET_SUPPLY_PARTY')) throw new ForbiddenError('Access denied');
  }
}
