import { RequestMethod, type INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  CATALOG_ROUTES,
  CUSTOMER_GOODS_ROUTES,
  CUSTOMER_HOME_ROUTES,
  IDENTITY_ROUTES,
  ORDER_ROUTES,
  ORGANIZATION_ROUTES,
  PRICING_ROUTES,
  PRODUCT_IMAGE_ROUTES,
} from '@iorder/shared';
import {
  MARKED_ORDER_NOTIFICATION_ROUTES,
  STAFF_AUTH_ROUTES,
  STAFF_PROFILE_ROUTES,
} from '@iorder/shared/staff-auth';
import {
  BRAND_ROUTES,
  COST_ROUTES,
  MANUAL_PRODUCT_ROUTES,
  PRODUCT_SUCCESSION_ROUTES,
  PRODUCT_TRACKING_ROUTES,
} from '@iorder/shared/staff-cost';
import {
  STAFF_DASHBOARD_ROUTES,
  STAFF_DRIVER_ROUTES,
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  STAFF_USER_ROUTES,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { PrismaService } from './common/database/prisma.service.js';
import { APP_ENV } from './config/config.module.js';
import { AuthController } from './modules/identity/auth.controller.js';
import { BrandController } from './modules/catalog/brand.controller.js';
import { CatalogController } from './modules/catalog/catalog.controller.js';
import {
  ProductImageMediaController,
  ProductImagesController,
} from './modules/catalog/product-images.controller.js';
import { ProductTrackingController } from './modules/catalog/product-tracking.controller.js';
import { DashboardController } from './modules/dashboard/dashboard.controller.js';
import {
  MeController,
  StaffDriversController,
  StaffPeopleController,
  StaffUsersController,
} from './modules/identity/identity.controller.js';
import { StaffAccountsController } from './modules/identity/staff-accounts.controller.js';
import { StaffCustomerSiteController } from './modules/identity/staff-customer-site.controller.js';
import { OwnStaffProfileController } from './modules/identity/own-staff-profile.controller.js';
import { OrganizationsController } from './modules/organizations/organizations.controller.js';
import { StaffOrganizationInvitesController } from './modules/telegram/staff-organization-invites.controller.js';
import { CostReferenceController } from './modules/pricing/cost-reference.controller.js';
import { StaffStockController } from './modules/pricing/staff-stock.controller.js';
import { SupplyRemovalController } from './modules/pricing/supply-removal/supply-removal.controller.js';
import { CartController } from './modules/orders/cart.controller.js';
import { OrdersController } from './modules/orders/orders.controller.js';
import { StaffOrdersController } from './modules/orders/staff-orders.controller.js';
import { PickingController } from './modules/orders/picking.controller.js';
import { CustomerGoodsController } from './modules/orders/customer-goods.controller.js';
import { SheetSyncRunController } from './modules/sheets-sync/sheet-sync-run.controller.js';
import { PricingController } from './modules/pricing/pricing.controller.js';
import { PriceListFileController } from './modules/pricing/price-list-file.controller.js';
import { ByOrderProductsController } from './modules/manual-products/by-order-products.controller.js';
import { ManualProductsController } from './modules/manual-products/manual-products.controller.js';
import { PriceImportController } from './modules/manual-products/price-import/price-import.controller.js';
import { CustomerRecommendationsController } from './modules/recommendations/customer-recommendations.controller.js';
import { ProductSuccessionsController } from './modules/recommendations/product-successions.controller.js';

// Nest keeps the path and the HTTP verb of a controller or handler under these metadata keys.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

const normalize = (...parts: string[]): string =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter((segment) => segment !== '')
    .join('/');

describe('shared route table matches the Nest router', () => {
  let app: INestApplication;
  const actual = new Set<string>();
  // Controllers in the order Nest registers their routes.
  const registration: unknown[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENV)
      .useValue({ NODE_ENV: 'test', PORT: 0, DATABASE_URL: 'postgresql://unused' })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    for (const module of moduleRef.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        registration.push(controller);
        if (
          controller !== CatalogController &&
          controller !== PricingController &&
          controller !== CostReferenceController &&
          controller !== SupplyRemovalController &&
          controller !== MeController &&
          controller !== AuthController &&
          controller !== StaffUsersController &&
          controller !== StaffAccountsController &&
          controller !== StaffCustomerSiteController &&
          controller !== OwnStaffProfileController &&
          controller !== StaffDriversController &&
          controller !== StaffPeopleController &&
          controller !== OrganizationsController &&
          controller !== StaffOrganizationInvitesController &&
          controller !== StaffStockController &&
          controller !== SheetSyncRunController &&
          controller !== CartController &&
          controller !== OrdersController &&
          controller !== StaffOrdersController &&
          controller !== DashboardController &&
          controller !== ProductTrackingController &&
          controller !== PickingController &&
          controller !== CustomerGoodsController &&
          controller !== BrandController &&
          controller !== PriceListFileController &&
          controller !== ProductImagesController &&
          controller !== ProductImageMediaController &&
          controller !== ManualProductsController &&
          controller !== PriceImportController &&
          controller !== ByOrderProductsController &&
          controller !== CustomerRecommendationsController &&
          controller !== ProductSuccessionsController
        ) {
          continue;
        }
        const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (method === undefined) continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
          actual.add(`${RequestMethod[method]} ${normalize(base, path)}`);
        }
      }
    }
  });
  afterAll(async () => {
    await app.close();
  });

  const declared = [
    ...Object.values(CATALOG_ROUTES),
    ...Object.values(PRICING_ROUTES),
    ...Object.values(IDENTITY_ROUTES),
    ...Object.values(STAFF_AUTH_ROUTES),
    ...Object.values(STAFF_PROFILE_ROUTES),
    ...Object.values(ORGANIZATION_ROUTES),
    ...Object.values(COST_ROUTES),
    ...Object.values(ORDER_ROUTES),
    ...Object.values(STAFF_ORDER_ROUTES),
    ...Object.values(MARKED_ORDER_NOTIFICATION_ROUTES),
    ...Object.values(STAFF_DRIVER_ROUTES),
    ...Object.values(STAFF_DASHBOARD_ROUTES),
    ...Object.values(STAFF_USER_ROUTES),
    ...Object.values(PRODUCT_TRACKING_ROUTES),
    ...Object.values(STAFF_PICKING_ROUTES),
    ...Object.values(CUSTOMER_GOODS_ROUTES),
    ...Object.values(BRAND_ROUTES),
    ...Object.values(PRODUCT_IMAGE_ROUTES),
    ...Object.values(MANUAL_PRODUCT_ROUTES),
    ...Object.values(CUSTOMER_HOME_ROUTES),
    ...Object.values(PRODUCT_SUCCESSION_ROUTES),
  ].map((route) => `${route.method} ${normalize(route.path)}`);

  it('every route in the table exists in the api', () => {
    expect(actual.size).toBeGreaterThan(0);
    expect(declared.filter((route) => !actual.has(route))).toEqual([]);
  });

  it('every catalog/pricing/identity/organization/order api route is in the table', () => {
    expect([...actual].filter((route) => !declared.includes(route))).toEqual([]);
  });

  // Segment-wise match as the router sees a request path: a `:param` segment matches any one
  // segment, a fixed one only itself, and the counts must be equal.
  const matchesPath = (routePath: string, requestPath: string): boolean => {
    const route = routePath.split('/').filter((s) => s !== '');
    const request = requestPath.split('/').filter((s) => s !== '');
    return (
      route.length === request.length &&
      route.every((segment, i) => segment.startsWith(':') || segment === request[i])
    );
  };
  const handlersOf = (method: string, requestPath: string): string[] =>
    [...actual]
      .filter((route) => route.startsWith(`${method} `))
      .map((route) => route.slice(method.length + 1))
      .filter((routePath) => matchesPath(routePath, requestPath));

  it('GET /staff/products/manual/check and :id/merge-preview are each matched by one route only', () => {
    // Otherwise a `:id` route of the same prefix could answer 400 "invalid uuid" instead.
    expect(handlersOf('GET', MANUAL_PRODUCT_ROUTES.checkManualProduct.path)).toEqual([
      MANUAL_PRODUCT_ROUTES.checkManualProduct.path,
    ]);
    expect(
      handlersOf('GET', '/staff/products/019a0000-0000-7000-8000-000000000001/merge-preview'),
    ).toEqual([MANUAL_PRODUCT_ROUTES.mergePreview.path]);
  });

  it('GET /staff/by-order-products is matched by one route only', () => {
    // Its own prefix: under /staff/products the catalog's `:id` route would also match it.
    expect(handlersOf('GET', MANUAL_PRODUCT_ROUTES.byOrderProducts.path)).toEqual([
      MANUAL_PRODUCT_ROUTES.byOrderProducts.path,
    ]);
  });

  it('registers GET /staff/products/unpriced before GET /staff/products/:id of the catalog', () => {
    // Otherwise "unpriced" would be read as a product id and answer 400/422.
    expect(registration.indexOf(StaffStockController)).toBeGreaterThanOrEqual(0);
    expect(registration.indexOf(StaffStockController)).toBeLessThan(
      registration.indexOf(CatalogController),
    );
  });
});
