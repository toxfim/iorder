import { PrismaService } from '../../src/common/database/prisma.service.js';
import { getTestDatabaseUrl } from './test-env.js';

export function createTestPrisma(): PrismaService {
  return new PrismaService({ DATABASE_URL: getTestDatabaseUrl() });
}

/**
 * Empties the catalog, pricing and audit tables. The immutability triggers would (correctly)
 * block this, so the reset runs with triggers disabled for this one transaction only.
 * Needs a superuser, which the local test database has; production code never does this.
 */
export async function resetCatalogPricingAudit(prisma: PrismaService): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`DELETE FROM app_settings`;
    await tx.$executeRaw`TRUNCATE sheet_sync_runs, audit_log, product_successions, supply_parties, supply_removal_requests, price_list_version_rates, stock_cache, price_reference, price_list_items, price_list_versions, product_translations, products, product_categories CASCADE`;
  });
}

/** Empties the identity tables and the audit log (triggers off for this one transaction, as above). */
export async function resetIdentity(prisma: PrismaService): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`TRUNCATE audit_log, staff_sessions, staff_credentials, organization_invites, organization_members, user_roles, organizations, users CASCADE`;
  });
}

/** Empties the order tables and carts (triggers off for this one transaction, as above). */
export async function resetOrders(prisma: PrismaService): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`TRUNCATE notification_outbox, order_events, order_items, organization_payments, orders, cart_items, carts CASCADE`;
  });
}
