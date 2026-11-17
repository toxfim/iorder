import { Injectable } from '@nestjs/common';
import type { ProductSuccessionDecision, ProductSuccessionStatus } from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService, type AuditChanges } from '../audit/index.js';
import { BrandService, CatalogService, type ProductView } from '../catalog/index.js';
import { PricingService } from '../pricing/index.js';
import { RecommendationsRepository, type SuccessionRow } from './recommendations.repository.js';
import { proposeSuccessions } from './succession-proposals.js';

const ENTITY = 'PRODUCT_SUCCESSION';

export interface SuccessionListView {
  rows: SuccessionRow[];
  counts: Record<ProductSuccessionStatus, number>;
  /** Both products of every row, by id. */
  products: Map<string, ProductView>;
  /** Products in the current published price list. */
  priced: ReadonlySet<string>;
}

/**
 * "Newer model" pairs [C, owner 2026-11-09]. The generator proposes, a manager or admin decides;
 * the customer side (CustomerRecommendationsService) reads CONFIRMED rows only. Every write is
 * audited in the same transaction (hard rule 12).
 */
@Injectable()
export class ProductSuccessionsService {
  constructor(
    private readonly repository: RecommendationsRepository,
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** The review list (manager, admin and the purchasing manager, who reads). */
  async list(actor: Actor, status: ProductSuccessionStatus): Promise<SuccessionListView> {
    if (!can(actor, 'VIEW_PRICE_ADMIN')) throw new ForbiddenError('Access denied');
    const [rows, counts, { published }] = await Promise.all([
      this.repository.listSuccessions(status),
      this.repository.countByStatus(),
      this.pricing.getPricedProductSets(),
    ]);
    const products = await this.catalog.findProductsByIds([
      ...new Set(rows.flatMap((row) => [row.olderProductId, row.newerProductId])),
    ]);
    return { rows, counts, products: new Map(products.map((p) => [p.id, p])), priced: published };
  }

  /**
   * "Find proposals": reads every product once, proposes pairs from names and brands and inserts
   * the ones that do not exist yet in ANY status, so a decision is never overwritten or re-asked.
   * Answers how many new proposals were made.
   */
  async findProposals(actor: Actor): Promise<number> {
    this.assertMayDecide(actor);
    const [products, { published }, bought, existing] = await Promise.all([
      this.catalog.listProducts(actor),
      this.pricing.getPricedProductSets(),
      this.repository.boughtProductIds(),
      this.repository.existingPairKeys(),
    ]);
    const brandOf = await this.brands.resolveBrands(products);
    const proposals = proposeSuccessions(
      products.map((product) => ({
        id: product.id,
        name: productName(product),
        brandKey: brandOf.get(product.id)?.name.trim().toLowerCase() ?? null,
        isActive: product.isActive,
      })),
      { pricedProductIds: published, boughtProductIds: bought },
    ).filter((pair) => !existing.has(`${pair.olderProductId}|${pair.newerProductId}`));
    if (proposals.length === 0) return 0;

    const now = this.clock.now();
    return this.repository.transaction(async (tx) => {
      const inserted = await this.repository.insertProposals(tx, proposals, now);
      await Promise.all(
        proposals.map((pair) =>
          this.audit.record(tx, {
            actorUserId: actor.userId,
            entityType: ENTITY,
            entityId: `${pair.olderProductId}|${pair.newerProductId}`,
            action: 'PROPOSED',
            changes: {
              olderProductId: { from: null, to: pair.olderProductId },
              newerProductId: { from: null, to: pair.newerProductId },
              status: { from: null, to: 'PROPOSED' },
            },
          }),
        ),
      );
      return inserted;
    });
  }

  /**
   * Confirms or rejects a pair. A decided pair may be decided again the other way (the same
   * people correct a wrong click); the trigger forbids a way back to PROPOSED. Idempotent: the
   * same decision twice changes nothing and writes no audit row.
   */
  async decide(
    actor: Actor,
    id: string,
    decision: ProductSuccessionDecision,
  ): Promise<SuccessionRow> {
    this.assertMayDecide(actor);
    return this.repository.transaction(async (tx) => {
      const row = await this.repository.findSuccession(id, tx);
      if (row === null) throw new NotFoundError('Product succession not found');
      if (row.status === decision) return row;
      const decidedAt = this.clock.now();
      const updated = await this.repository.decide(tx, id, {
        status: decision,
        decidedBy: actor.userId,
        decidedAt,
      });
      const changes: AuditChanges = {
        status: { from: row.status, to: decision },
        olderProductId: { from: row.olderProductId, to: row.olderProductId },
        newerProductId: { from: row.newerProductId, to: row.newerProductId },
      };
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY,
        entityId: id,
        action: decision,
        changes,
      });
      return updated;
    });
  }

  private assertMayDecide(actor: Actor): void {
    if (!can(actor, 'DECIDE_PRODUCT_SUCCESSION')) throw new ForbiddenError('Access denied');
  }
}

/** The brand finder reads the Russian sheet name first; the generator reads the same text. */
function productName(product: ProductView): string {
  return (
    product.translations.find((t) => t.lang === 'RU')?.name ??
    product.translations[0]?.name ??
    product.productCode
  );
}
