import { commonProductName, type PriceTier } from '@iorder/shared';
import {
  NEW_ORDER_CUSTOMER_LIMIT,
  NEW_ORDER_RECENT_CUSTOMER_LIMIT,
  type NewOrderCustomerQuery,
} from '@iorder/shared/staff-orders';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { BrandService, CatalogService } from '../catalog/index.js';
import { OrganizationsService, type OrderCustomer } from '../organizations/index.js';
import { PricingService, type PriceListView } from '../pricing/index.js';
import { OrdersRepository } from './orders.repository.js';

/** One product step 2 offers, before the HTTP mapping. Staff-only. */
export interface NewOrderCatalogEntry {
  productId: string;
  productCode: string;
  name: string;
  category: string | null;
  brand: string | null;
  imageId: string | null;
  unitPrice: Prisma.Decimal;
  deferredUnitPrice: Prisma.Decimal | null;
  /** Free whole pieces; null = not tracked or unknown. A hint, never a limit for the manager [P]. */
  stock: Prisma.Decimal | null;
}

export interface NewOrderCatalog {
  organizationId: string;
  priceTier: PriceTier;
  items: NewOrderCatalogEntry[];
}

/**
 * The reads behind the manager's new order [C, owner 2026-11-20] (manager only): step 1's
 * customers, with the «Oxirgi mijozlar» chips [P], and step 2's catalog of one organization at its
 * tier. The order itself is written by OrdersService.createForCustomer. Other modules through their
 * exported services only.
 */
@Injectable()
export class StaffNewOrderService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly organizations: OrganizationsService,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
  ) {}

  async customers(
    actor: Actor,
    query: NewOrderCustomerQuery,
  ): Promise<{ items: OrderCustomer[]; recent: OrderCustomer[] }> {
    this.assertMayCreate(actor);
    const items = await this.organizations.findOrderCustomers(query, NEW_ORDER_CUSTOMER_LIMIT);
    // [P] the organizations of the latest orders; a few spare ids cover inactive ones.
    const recentIds = await this.repository.recentOrganizationIds(
      NEW_ORDER_RECENT_CUSTOMER_LIMIT * 3,
    );
    const found = new Map(
      (await this.organizations.findOrderCustomers({ ids: recentIds }, recentIds.length || 1)).map(
        (customer) => [customer.id, customer],
      ),
    );
    const recent = recentIds
      .flatMap((id) => {
        const customer = found.get(id);
        return customer === undefined || customer.members.length === 0 ? [] : [customer];
      })
      .slice(0, NEW_ORDER_RECENT_CUSTOMER_LIMIT);
    return { items, recent };
  }

  async catalogFor(actor: Actor, organizationId: string): Promise<NewOrderCatalog> {
    this.assertMayCreate(actor);
    if (!(await this.organizations.isActive(organizationId))) {
      throw new ConflictError(
        'This organization cannot place orders',
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    }
    let list: PriceListView;
    try {
      list = await this.pricing.getCatalogForOrganization(organizationId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ConflictError('No price list has been published yet', 'NO_PUBLISHED_VERSION');
      }
      throw error;
    }
    const products = list.items.map((item) => item.product);
    const [stock, brands, images] = await Promise.all([
      this.pricing.getOrderableStock(products),
      this.brands.resolveBrands(products),
      this.catalog.primaryImageIds(products.map((product) => product.id)),
    ]);
    return {
      organizationId,
      priceTier: list.priceTier ?? 'STANDARD',
      items: list.items.map((item) => ({
        productId: item.product.id,
        productCode: item.product.productCode,
        name: commonProductName(item.product.translations, item.product.productCode),
        category: item.product.category,
        brand: brands.get(item.product.id)?.name ?? null,
        imageId: images.get(item.product.id) ?? null,
        unitPrice: item.basePrice,
        deferredUnitPrice: item.deferredPrice,
        stock: stock.get(item.product.id) ?? null,
      })),
    };
  }

  private assertMayCreate(actor: Actor): void {
    if (!can(actor, 'CREATE_ORDER_FOR_CUSTOMER')) throw new ForbiddenError('Access denied');
  }
}
