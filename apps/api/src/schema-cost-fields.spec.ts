import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STAFF_PRICE_TIER_NAMES,
  extractSchemaNames,
  findForbiddenKeys,
  isForbiddenName,
  isStaffOnlyFieldName,
} from '../test/support/forbidden-fields.js';

// Hard rule 7 at the schema level: a cost-like column in any table of this phase fails here,
// before it can ever reach a response. When cost data arrives it belongs in its own staff-only
// area (data-model §6.2); this test then needs a deliberate, reviewed change.
const SCHEMA_DIR = new URL('../prisma/schema/', import.meta.url);
// The ONLY schema file allowed to hold cost-like names: the staff-only cost reference table.
// Allow-listed by file name on purpose; it must contain nothing but that model (checked below).
// Each file may hold ONLY the listed models.
const STAFF_ONLY_COST_SCHEMA_FILES: Record<string, readonly string[]> = {
  'price-reference.prisma': ['PriceReference'],
  'rates.prisma': ['PriceListVersionRate'],
  // Run history: skipped suppliers and cost mismatches, so it is cost-like by design.
  'sheet-sync.prisma': ['SheetSyncRun'],
};
const allSchemaFiles = readdirSync(SCHEMA_DIR).filter(
  (f) => f.endsWith('.prisma') && f !== 'schema.prisma',
);
// Files that may carry staff-only FIELD names (delivery refs) but must still be free of cost words.
const STAFF_ONLY_FIELD_FILES: Record<string, readonly string[]> = {
  'supply-removals.prisma': ['SupplyRemovalStatus', 'SupplyRemovalRequest'],
  'supply-parties.prisma': ['SupplyParty'],
};
// The stock holds: a line id and a quantity, no cost. Pinned field by field below.
const ALLOCATION_SCHEMA_FILE = 'order-allocations.prisma';
const schemaFiles = allSchemaFiles.filter((f) => !(f in STAFF_ONLY_COST_SCHEMA_FILES));
// The USD debt (owner rule): the only cost-class columns allowed on these tables, by exact name. They
// are staff-only by mapping: the DTO allow-lists and the customer leak tests keep them out of every
// customer response. Any other cost-like name on these tables still fails.
const USD_DEBT_COLUMNS: Record<string, readonly string[]> = {
  'orders.prisma': [
    'usdRate',
    'usd_rate',
    'totalUsd',
    'total_usd',
    'fullUnitPriceUsd',
    'full_unit_price_usd',
    'deferredUnitPriceUsd',
    'deferred_unit_price_usd',
  ],
  'organization-payments.prisma': ['rate', 'amountUsd', 'amount_usd'],
};

// [C, owner 2026-11-11] The «Оптовик/Партнер» SELLING price tier: the label and tier enum values and
// the tier's price columns. Selling prices, not cost (see STAFF_PRICE_TIER_NAMES); exactly here.
const PRICE_TIER_COLUMNS: Record<string, readonly string[]> = {
  'organizations.prisma': ['WHOLESALE', 'WHOLESALE_PARTNER', 'ALIF_FACTORING'],
  'pricing.prisma': [
    'wholesalePrice',
    'wholesale_price',
    'wholesaleDeferredPrice',
    'wholesale_deferred_price',
    // [C, owner 2026-11-12] the «Alif factoring» tier's selling prices.
    'alifPrice',
    'alif_price',
    'alifDeferredPrice',
    'alif_deferred_price',
  ],
};

describe('Prisma schema has no cost-like names', () => {
  it('the price tier allowance names only the reviewed tier names', () => {
    for (const names of Object.values(PRICE_TIER_COLUMNS)) {
      for (const name of names) expect(STAFF_PRICE_TIER_NAMES).toContain(name);
    }
  });

  it('finds the schema files and the tables of this phase', () => {
    const all = schemaFiles.flatMap((f) =>
      extractSchemaNames(readFileSync(new URL(f, SCHEMA_DIR), 'utf8')),
    );
    for (const expected of [
      'products',
      'product_translations',
      'price_list_versions',
      'price_list_items',
      'audit_log',
      'base_price',
    ]) {
      expect(all, expected).toContain(expected);
    }
  });

  it.each(schemaFiles)('%s declares no forbidden model, column or enum names', (file) => {
    const names = extractSchemaNames(readFileSync(new URL(file, SCHEMA_DIR), 'utf8'));
    const allowed = [...(USD_DEBT_COLUMNS[file] ?? []), ...(PRICE_TIER_COLUMNS[file] ?? [])];
    expect(names.filter((name) => isForbiddenName(name) && !allowed.includes(name))).toEqual([]);
  });

  it.each(Object.entries(USD_DEBT_COLUMNS))('%s really has its USD debt columns', (file, names) => {
    const declared = extractSchemaNames(readFileSync(new URL(file, SCHEMA_DIR), 'utf8'));
    expect(declared).toEqual(expect.arrayContaining([...names]));
  });
});

describe('staff-only delivery and stock fields stay out of every other Prisma file', () => {
  // stock.prisma IS the staff-only stock aggregate (checked exactly below), so it is not scanned
  // for the stock names. catalog.prisma owns the relation field `stock` on Product: a relation, not a
  // column, and the only allowed mention.
  const ALLOWED_RELATION_FIELDS: Record<string, readonly string[]> = {
    // `stock` is the relation to the aggregate; `category` is the staff-only product category
    // (kept out of every DTO by the contract scans below and the leak tests).
    'catalog.prisma': ['stock', 'category'],
  };
  const scannedFiles = schemaFiles.filter(
    (file) => file !== 'stock.prisma' && !(file in STAFF_ONLY_FIELD_FILES),
  );

  it.each(scannedFiles)(
    '%s has no supplier, purchase method, category, stock or delivery columns',
    (file) => {
      const names = extractSchemaNames(readFileSync(new URL(file, SCHEMA_DIR), 'utf8')).filter(
        (name) => !(ALLOWED_RELATION_FIELDS[file] ?? []).includes(name),
      );
      expect(names.filter(isStaffOnlyFieldName)).toEqual([]);
    },
  );

  it('stock.prisma is the aggregate only: product_id, quantity, synced_at and nothing cost-like', () => {
    const names = extractSchemaNames(readFileSync(new URL('stock.prisma', SCHEMA_DIR), 'utf8'));
    expect(names.filter((n) => !['StockCache', 'stock_cache'].includes(n)).sort()).toEqual(
      ['product', 'productId', 'product_id', 'quantity', 'syncedAt', 'synced_at'].sort(),
    );
    expect(names.filter(isForbiddenName)).toEqual([]);
  });
});

describe('staff-only field files (delivery refs) hold only their models and stay free of cost words', () => {
  it.each(Object.entries(STAFF_ONLY_FIELD_FILES))('%s', (file, expected) => {
    const text = readFileSync(new URL(file, SCHEMA_DIR), 'utf8');
    const declared = [...text.matchAll(/^(?:model|enum)\s+(\w+)/gm)].map((m) => m[1]);
    expect(declared).toEqual(expected);
    expect(extractSchemaNames(text).filter(isForbiddenName)).toEqual([]);
    expect(extractSchemaNames(text).filter(isStaffOnlyFieldName).length).toBeGreaterThan(0);
  });
});

describe('the staff-only cost schema file', () => {
  it('holds only the price_reference model, and really is cost-like (the allow-list is not stale)', () => {
    for (const [file, expectedModels] of Object.entries(STAFF_ONLY_COST_SCHEMA_FILES)) {
      const text = readFileSync(new URL(file, SCHEMA_DIR), 'utf8');
      const models = [...text.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
      expect(models, file).toEqual(expectedModels);
      expect(extractSchemaNames(text).filter(isForbiddenName).length).toBeGreaterThan(0);
    }
  });

  it('no customer-facing table has a foreign key into it (schema files do not mention it)', () => {
    for (const file of schemaFiles) {
      const text = readFileSync(new URL(file, SCHEMA_DIR), 'utf8').replace(/\/\/.*$/gm, '');
      // catalog.prisma owns the Product back-relation, pricing.prisma the version's snapshot
      // relation, and order-allocations.prisma its key to a delivery line: the only allowed mentions.
      if (file !== 'catalog.prisma' && file !== ALLOCATION_SCHEMA_FILE) {
        expect(text, file).not.toContain('PriceReference');
      }
      if (file !== 'pricing.prisma') expect(text, file).not.toContain('PriceListVersionRate');
      if (file !== 'catalog.prisma' && !(file in STAFF_ONLY_FIELD_FILES)) {
        expect(text, file).not.toContain('SupplyRemovalRequest');
      }
    }
  });
});

// The one staff table with a foreign key into the cost table, so it is pinned column by column
// instead of merely excused: a line id and a quantity, and a new column here (a copied cost, a
// supplier) fails until someone reviews it. It never reaches a customer: the customer schemas have no
// allocation field and order-allocations.int-spec.ts proves it on a live response.
describe('order-allocations.prisma', () => {
  const text = readFileSync(new URL(ALLOCATION_SCHEMA_FILE, SCHEMA_DIR), 'utf8');

  it('holds only the allocation model', () => {
    expect([...text.matchAll(/^(?:model|enum)\s+(\w+)/gm)].map((m) => m[1])).toEqual([
      'OrderAllocation',
    ]);
  });

  it('has exactly the reviewed fields and names the cost table only in that relation', () => {
    const uncommented = text.replace(/\/\/.*$/gm, '');
    const fields = [...uncommented.matchAll(/^[ \t]+(\w+)[ \t]+\w+/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(
      [
        'id',
        'orderId',
        'orderItemId',
        'productId',
        'priceReferenceId',
        'quantity',
        'createdBy',
        'createdAt',
        'holdEndedAt',
        'voidedAt',
        'voidedBy',
        'order',
        'orderItem',
        'product',
        'priceReference',
        'creator',
        'voider',
      ].sort(),
    );
    expect(uncommented.match(/PriceReference/g)).toHaveLength(1);
    expect(extractSchemaNames(text).filter(isForbiddenName)).toEqual([]);
    expect(extractSchemaNames(text).filter(isStaffOnlyFieldName)).toEqual([]);
  });
});

describe('the detectors themselves', () => {
  it('catches cost-like columns in schema text, ignoring comments', () => {
    const schema = `
      /// purchase price is NOT stored here
      model Product {
        id String @id
        purchase_price Decimal @map("purchase_price")
        landedCost Decimal
        // supplier is mentioned only in a comment
        @@map("products")
      }`;
    const flagged = extractSchemaNames(schema.replace(/^\s+/gm, '')).filter(isForbiddenName);
    expect(flagged).toEqual(['purchase_price', 'purchase_price', 'landedCost']);
  });

  it('matches regardless of case, separators and depth', () => {
    expect(findForbiddenKeys({ a: [{ b: { 'buy-price': 1, BuyPrice: 2 } }] })).toHaveLength(2);
    expect(
      findForbiddenKeys({
        Supplier: 1,
        exchangeRate: 2,
        Margin: 3,
        tannarx: 4,
        kurs: 5,
        markup: 6,
        unitCost: 7,
        COGS: 8,
        profit: 9,
        landed_total: 10,
        internalNote: 11,
        wholesalePrice: 12,
        alifPrice: 13,
      }),
    ).toHaveLength(13);
    expect(
      findForbiddenKeys({ price: '1', productCode: 'x', createdAt: 'y', translations: [] }),
    ).toEqual([]);
  });
});
