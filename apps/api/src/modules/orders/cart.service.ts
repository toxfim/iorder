import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { PIECE_UNIT, commonProductName } from '@iorder/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { CatalogService } from '../catalog/index.js';
import { PricingService, type OrderableStock } from '../pricing/index.js';
import { MAX_QUANTITY, parseQuantity, sumAmounts, lineTotal } from './order-lines.js';
import { orderabilityProblem, type PriceBook, type PriceBookEntry } from './order-pricing.js';
import { exceedsStock, stockLimitExceeded, stockLimitOf } from './stock-limit.js';
import { OrdersRepository, type CartItemRecord } from './orders.repository.js';
import type { CartLineView, CartView } from './order.views.js';

/** Whose cart it is. `organizationId` null: a staff viewer's personal cart (no organization). */
export interface CartOwner {
  userId: string;
  organizationId: string | null;
}

/**
 * The cart holds product ids and quantities and NO prices (data-model). It is priced with the
 * published price list whenever it is shown or submitted. A customer's cart is always in their own
 * organization. A staff viewer ([C] 2026-11-09) has a personal cart that belongs to no
 * organization: it works in production, where no staff order is possible, and it never sits among
 * a real organization's rows.
 *
 * A quantity cannot be set above what can be ordered now [C, 2026-11-09], for a customer and a staff
 * viewer alike, and a product that is out of stock (a figure of zero) cannot be put in at all; a
 * line that ended up above the figure (the stock fell later) blocks submitting until it is lowered
 * or, at zero, removed. Nothing is reserved: two carts may each hold the last pieces (hard rule 10).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
    private readonly clock: Clock,
  ) {}

  async getCart(actor: Actor): Promise<CartView> {
    const owner = this.cartOwnerOf(actor);
    const items = await this.repository.findCartItems(owner.userId, owner.organizationId);
    return this.toView(actor, items);
  }

  /** Adds to the quantity already in the cart. */
  async addItem(actor: Actor, productId: string, quantity: string): Promise<CartView> {
    const amount = this.requireQuantity(quantity);
    return this.change(actor, productId, (current) =>
      (current ?? new Prisma.Decimal(0)).plus(amount),
    );
  }

  /** Sets the quantity (creating the line when missing). */
  async setItemQuantity(actor: Actor, productId: string, quantity: string): Promise<CartView> {
    const amount = this.requireQuantity(quantity);
    return this.change(actor, productId, () => amount);
  }

  async removeItem(actor: Actor, productId: string): Promise<CartView> {
    const owner = this.cartOwnerOf(actor);
    const now = this.clock.now();
    await this.repository.transaction(async (tx) => {
      const cartId = await this.repository.lockCart(tx, owner.userId, owner.organizationId, now);
      await this.repository.deleteCartItem(tx, cartId, productId, now);
    });
    return this.getCart(actor);
  }

  /**
   * A product merge [C, 2026-11-09], inside the caller's transaction: every open cart line of the
   * merged product becomes a line of the target, adding up where a cart has both (capped at the
   * cart's own quantity limit). Returns how many lines moved. The caller has authorized the actor.
   */
  moveCartLinesIn(tx: Tx, sourceProductId: string, targetProductId: string): Promise<number> {
    return this.repository.moveCartLines(
      tx,
      sourceProductId,
      targetProductId,
      MAX_QUANTITY,
      this.clock.now(),
    );
  }

  /**
   * For other modules (the merge preview; the caller authorizes): how many open cart lines, over
   * all organizations, hold this product. A count only: no cart content leaves the module.
   */
  countCartLines(productId: string): Promise<number> {
    return this.repository.countCartLines(productId);
  }

  /**
   * The cart the actor works with: their organization's for a customer, the personal one for a
   * staff viewer. Always the actor's OWN user id; nothing here comes from the request.
   */
  cartOwnerOf(actor: Actor): CartOwner {
    if (isStaffViewer(actor)) {
      if (!can(actor, 'USE_CART')) throw new ForbiddenError('Access denied');
      return { userId: actor.userId, organizationId: null };
    }
    return { userId: actor.userId, organizationId: this.requireOrganization(actor) };
  }

  /**
   * The organization an order of this actor is written to. A customer: their own. A staff viewer:
   * ONLY the organization configured for staff orders (staging); where none is configured, as in
   * production, the order is refused here, on the server, whatever the client shows. Never any
   * other organization, and never one taken from the request.
   */
  orderingOrganizationOf(actor: Actor): string {
    if (!isStaffViewer(actor)) return this.requireOrganization(actor);
    const organizationId = actor.staffViewer?.orderingOrganizationId ?? null;
    if (organizationId === null) {
      throw new ConflictError('Staff members cannot place orders here', 'STAFF_ORDERING_DISABLED');
    }
    if (!can(actor, 'SUBMIT_ORDER', { organizationId })) throw new ForbiddenError('Access denied');
    return organizationId;
  }

  /** Customer only: a member of the organization. Staff are never members of one. */
  requireOrganization(actor: Actor): string {
    const organizationId = effectiveMembership(actor)?.organizationId;
    if (organizationId === undefined || !can(actor, 'SUBMIT_ORDER', { organizationId })) {
      throw new ForbiddenError('Access denied');
    }
    return organizationId;
  }

  /**
   * The current published price list as a lookup, or null while nothing is published. The
   * version and its items are read together: items of a published version never change, so a
   * publish that happens right after still leaves a consistent (older) snapshot.
   */
  async loadPriceBook(actor: Actor): Promise<PriceBook | null> {
    let list;
    try {
      list = await this.pricing.getCurrentForCustomer(actor);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    return {
      versionId: list.version.id,
      versionNumber: list.version.number,
      // The customer view is always resolved to one tier; STANDARD is only the type's fallback.
      priceTier: list.priceTier ?? 'STANDARD',
      usdRate: list.usdRate,
      entries: new Map(
        list.items.map((item) => [
          item.product.id,
          {
            product: item.product,
            unitPrice: item.basePrice,
            deferredUnitPrice: item.deferredPrice,
            fullUnitPriceUsd: item.usd?.basePrice ?? null,
            deferredUnitPriceUsd: item.usd?.deferredPrice ?? null,
            // Already in UZS: the customer list converts every price the same way.
            rrp: item.rrp,
          },
        ]),
      ),
    };
  }

  /**
   * How many pieces of the given products can be ordered now. Only products the book can sell are
   * asked about: a line that cannot be ordered at all shows no figure. Read through the pricing
   * module's own connection, like the book: stock is indicative, so "a moment ago" is as good as
   * the transaction's snapshot.
   */
  loadOrderableStock(
    book: PriceBook | null,
    productIds: readonly string[],
  ): Promise<OrderableStock> {
    const products = productIds.flatMap((productId) => {
      const entry = book?.entries.get(productId);
      return entry && orderabilityProblem(entry.product) === null ? [entry.product] : [];
    });
    return this.pricing.getOrderableStock(products);
  }

  private requireQuantity(quantity: string): Prisma.Decimal {
    const amount = parseQuantity(quantity);
    if (amount === null) {
      throw new InputValidationError([
        {
          path: 'quantity',
          message: `Quantity must be a whole number from 1 to ${MAX_QUANTITY.toFixed(0)}`,
        },
      ]);
    }
    return amount;
  }

  private async change(
    actor: Actor,
    productId: string,
    next: (current: Prisma.Decimal | null) => Prisma.Decimal,
  ): Promise<CartView> {
    const owner = this.cartOwnerOf(actor);
    const entry = await this.requireOrderable(actor, productId);
    const limit = stockLimitOf(await this.pricing.getOrderableStock([entry.product]), productId);
    const now = this.clock.now();
    await this.repository.transaction(async (tx) => {
      const cartId = await this.repository.lockCart(tx, owner.userId, owner.organizationId, now);
      const current = (await this.repository.findCartItemsLocked(tx, cartId)).find(
        (item) => item.productId === productId,
      );
      const quantity = next(current?.quantity ?? null);
      if (quantity.greaterThan(MAX_QUANTITY)) {
        throw new InputValidationError([
          {
            path: 'quantity',
            message: `The cart quantity cannot exceed ${MAX_QUANTITY.toFixed(0)}`,
          },
        ]);
      }
      // Also when lowering a line that is still above the figure: the answer names the figure.
      if (limit !== null && exceedsStock(quantity, limit)) {
        throw stockLimitExceeded([{ productId, orderableStock: limit }]);
      }
      await this.repository.upsertCartItem(tx, cartId, productId, quantity, now);
    });
    return this.getCart(actor);
  }

  /** A product can enter the cart only while it is active and in the published price list. */
  private async requireOrderable(actor: Actor, productId: string): Promise<PriceBookEntry> {
    const book = await this.loadPriceBook(actor);
    const entry = book?.entries.get(productId);
    if (entry && orderabilityProblem(entry.product) === null) return entry;
    const product = (await this.catalog.findProductsByIds([productId]))[0];
    if (!product) throw new NotFoundError('Product not found');
    throw new ConflictError('This product cannot be ordered right now', 'PRODUCT_NOT_ORDERABLE', {
      productIds: [productId],
    });
  }

  private async toView(actor: Actor, items: readonly CartItemRecord[]): Promise<CartView> {
    const book = await this.loadPriceBook(actor);
    const unknown = items.map((i) => i.productId).filter((id) => !book?.entries.has(id));
    const others = new Map((await this.catalog.findProductsByIds(unknown)).map((p) => [p.id, p]));
    const stock = await this.loadOrderableStock(
      book,
      items.map((item) => item.productId),
    );

    const lines: CartLineView[] = [];
    for (const item of items) {
      const entry = book?.entries.get(item.productId);
      if (entry) {
        // An unorderable product shows no price: the line blocks submitting (canSubmit below).
        const problem = orderabilityProblem(entry.product);
        const limit = problem === null ? stockLimitOf(stock, item.productId) : null;
        const deferred = problem === null ? entry.deferredUnitPrice : null;
        lines.push({
          productId: item.productId,
          productCode: entry.product.productCode,
          name: commonProductName(entry.product.translations, entry.product.productCode),
          unit: PIECE_UNIT,
          quantity: item.quantity,
          unitPrice: problem === null ? entry.unitPrice : null,
          lineTotal: problem === null ? lineTotal(item.quantity, entry.unitPrice) : null,
          deferredUnitPrice: deferred,
          deferredLineTotal: deferred === null ? null : lineTotal(item.quantity, deferred),
          rrp: problem === null ? entry.rrp : null,
          orderableStock: limit,
          // The product itself is fine, so the prices above stay: only the quantity must go down.
          problem: problem ?? (exceedsStock(item.quantity, limit) ? 'STOCK_EXCEEDED' : null),
        });
        continue;
      }
      const product = others.get(item.productId);
      if (!product) continue; // cannot happen: cart_items.product_id has a foreign key
      lines.push({
        productId: item.productId,
        productCode: product.productCode,
        name: commonProductName(product.translations, product.productCode),
        unit: PIECE_UNIT,
        quantity: item.quantity,
        unitPrice: null,
        lineTotal: null,
        deferredUnitPrice: null,
        deferredLineTotal: null,
        rrp: null,
        orderableStock: null,
        problem: product.isActive ? 'NOT_PRICED' : 'INACTIVE',
      });
    }
    lines.sort((a, b) => a.productCode.localeCompare(b.productCode));
    const submittable = lines.filter((line) => line.problem === null);
    const deferredTotals = lines.flatMap((line) =>
      line.deferredLineTotal ? [line.deferredLineTotal] : [],
    );
    return {
      priceListVersionNumber: book?.versionNumber ?? null,
      lines,
      // Every priced line counts, also one above the stock: the total is what the screen shows.
      totalAmount: sumAmounts(lines.flatMap((line) => (line.lineTotal ? [line.lineTotal] : []))),
      // Only a whole cart has a deferred total: one line without the price rules the plan out.
      deferredTotalAmount:
        lines.length > 0 && deferredTotals.length === lines.length
          ? sumAmounts(deferredTotals)
          : null,
      currency: 'UZS',
      canSubmit: lines.length > 0 && submittable.length === lines.length,
    };
  }
}
