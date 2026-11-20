import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../common/auth/actor.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { CatalogService, ProductWithStock } from '../catalog/index.js';
import type { PricingService } from './pricing.service.js';
import { countCategories, StaffStockService } from './staff-stock.service.js';

const entry = (category: string | null): ProductWithStock =>
  ({ product: { category }, stockQuantity: null }) as unknown as ProductWithStock;

describe('countCategories', () => {
  it('counts per category, sorts by code units (not by locale) and counts uncategorized apart', () => {
    const result = countCategories(
      ['b', 'B', 'a', 'é', 'Z', 'a', null, 'Смартфоны', 'Аксессуары', null].map(entry),
    );
    expect(result.uncategorizedCount).toBe(2);
    // Upper case before lower case, accented after plain Latin, Cyrillic after Latin: code unit order.
    expect(result.categories.map((c) => c.category)).toEqual([
      'B',
      'Z',
      'a',
      'b',
      'é',
      'Аксессуары',
      'Смартфоны',
    ]);
    expect(result.categories.find((c) => c.category === 'a')?.count).toBe(2);
  });

  it('is independent of the input order', () => {
    const input = ['x', 'y', 'X', 'Y', 'ü', 'u'];
    const forward = countCategories(input.map(entry)).categories;
    const backward = countCategories([...input].reverse().map(entry)).categories;
    expect(backward).toEqual(forward);
  });
});

describe('StaffStockService.countUnpricedActive', () => {
  const manager = { staffRoles: ['MANAGER'] } as unknown as Actor;
  const customer = { staffRoles: [], membership: null } as unknown as Actor;

  function make(publishedIds: string[]): {
    service: StaffStockService;
    count: ReturnType<typeof vi.fn>;
  } {
    const count = vi.fn().mockResolvedValue(4);
    const catalog = { countActiveProductsExcluding: count } as unknown as CatalogService;
    const pricing = {
      getPricedProductSets: vi
        .fn()
        .mockResolvedValue({ published: new Set(publishedIds), draft: new Set(['d1']) }),
    } as unknown as PricingService;
    return {
      service: new StaffStockService(catalog, pricing, {} as never, {} as never, {} as never),
      count,
    };
  }

  it('asks the catalog to count active products outside the published priced ids only', async () => {
    const { service, count } = make(['a', 'b']);
    expect(await service.countUnpricedActive(manager)).toBe(4);
    expect(count).toHaveBeenCalledWith(['a', 'b']);
  });

  it('refuses a caller without the cost-reference permission', async () => {
    const { service, count } = make([]);
    await expect(service.countUnpricedActive(customer)).rejects.toBeInstanceOf(ForbiddenError);
    expect(count).not.toHaveBeenCalled();
  });
});
