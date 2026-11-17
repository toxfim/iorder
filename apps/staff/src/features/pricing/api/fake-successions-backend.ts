import type { StaffRole } from '@iorder/shared';
import type {
  ProductSuccession,
  ProductSuccessionProduct,
  ProductSuccessionStatus,
} from '@iorder/shared/staff-cost';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { canEditPrices, canViewPriceAdmin } from '@/features/staff-shell/price-access';
import type { FakePriceBackendView } from './fake-price-backend';
import type { SuccessionsApi } from './successions-api';

export interface FakeSuccessionsBackendOptions {
  /** The price fake's catalog: the pairs name its products. */
  readonly view: FakePriceBackendView;
  readonly roles: () => readonly StaffRole[];
  readonly actor: () => { id: string; name: string } | null;
  readonly now: () => Date;
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
}

/** The demo pairs, by product code: one waiting for a decision, one the manager rejected. */
const SEEDS: readonly {
  older: string;
  newer: string;
  status: ProductSuccessionStatus;
}[] = [
  { older: '10524', newer: '10497', status: 'PROPOSED' },
  { older: '10491', newer: '10492', status: 'REJECTED' },
];

/**
 * In-memory stand-in for the "newer model" pair endpoints. It follows the contract: the price
 * management roles read, manager and admin find and decide; a decided pair can be decided again
 * the other way, never set back to PROPOSED; "find" never touches an existing pair (here it
 * finds nothing new after the seeds).
 */
export function createFakeSuccessionsBackend(options: FakeSuccessionsBackendOptions): {
  successionsApi: SuccessionsApi;
} {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? ((): FakeScenario => 'ready');

  const sideOf = (productCode: string): ProductSuccessionProduct => {
    const product = options.view.products().find((p) => p.productCode === productCode);
    if (!product) throw new Error(`Unknown fake product ${productCode}`);
    return {
      productId: product.id,
      productCode: product.productCode,
      name: product.name,
      priced: options.view.publishedProductIds().has(product.id),
      isActive: product.isActive,
    };
  };

  const pairs: ProductSuccession[] = SEEDS.map((seed, index) => ({
    id: fakeUuid(`succession:${seed.older}:${seed.newer}`),
    older: sideOf(seed.older),
    newer: sideOf(seed.newer),
    status: seed.status,
    proposedAt: new Date(options.now().getTime() - (index + 1) * 86_400_000).toISOString(),
    decidedAt:
      seed.status === 'PROPOSED'
        ? null
        : new Date(options.now().getTime() - index * 3_600_000).toISOString(),
    decidedBy: seed.status === 'PROPOSED' ? null : 'Fake Pricing Manager',
    decidedByUserId: seed.status === 'PROPOSED' ? null : fakeUuid('identity:manager'),
  }));

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  async function beforeRead(): Promise<'empty' | null> {
    const current = scenario();
    if (current === 'loading') return new Promise<never>(() => undefined);
    await delay();
    if (current === 'denied') throw new PermissionDeniedError();
    if (current === 'error') throw new Error('iorder-fake-price-backend: simulated failure');
    return current === 'empty' ? 'empty' : null;
  }

  const counts = (): Record<ProductSuccessionStatus, number> => ({
    PROPOSED: pairs.filter((p) => p.status === 'PROPOSED').length,
    CONFIRMED: pairs.filter((p) => p.status === 'CONFIRMED').length,
    REJECTED: pairs.filter((p) => p.status === 'REJECTED').length,
  });

  const successionsApi: SuccessionsApi = {
    async list(status) {
      const state = await beforeRead();
      if (!canViewPriceAdmin(options.roles())) throw new PermissionDeniedError();
      if (state === 'empty')
        return { items: [], counts: { PROPOSED: 0, CONFIRMED: 0, REJECTED: 0 } };
      // Reads the products again: a renamed or re-priced product shows as it is now.
      const items = pairs
        .filter((p) => p.status === status)
        .map((p) => ({
          ...p,
          older: sideOf(p.older.productCode),
          newer: sideOf(p.newer.productCode),
        }))
        .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
      return { items, counts: counts() };
    },
    async findProposals() {
      await delay();
      if (!canEditPrices(options.roles())) throw new PermissionDeniedError();
      return { proposedCount: 0 };
    },
    async decide(id, decision) {
      await delay();
      if (!canEditPrices(options.roles())) throw new PermissionDeniedError();
      const pair = pairs.find((p) => p.id === id);
      if (!pair) throw new ApiNotFoundError('Product succession not found', 'NOT_FOUND');
      if (pair.status === decision) return pair;
      const actor = options.actor();
      pair.status = decision;
      pair.decidedAt = options.now().toISOString();
      pair.decidedBy = actor?.name ?? 'Staff';
      pair.decidedByUserId = actor?.id ?? null;
      return { ...pair };
    },
  };

  return { successionsApi };
}
