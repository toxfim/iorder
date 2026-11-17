import type { Locale } from '@iorder/shared';

// Sample catalog and price history for the in-memory fake backend (dev, tests, VITE_USE_FAKE_API).
// The strings here must never reach a production bundle: scripts/check-bundle.mjs looks for them.

export const FAKE_PRICE_BACKEND_MARKER = 'iorder-fake-price-backend';

export interface FakeProductSeed {
  readonly productCode: string;
  /** The sheet's category of the latest delivery; null until a delivery is known. */
  readonly category: string | null;
  readonly isActive: boolean;
  readonly names: Readonly<Record<Locale, string>>;
  /**
   * So'm prices by version number (they match the demo orders); the fake list keeps them in USD
   * through `seedUsd`. A missing version means the product was not in that list.
   */
  readonly prices: Readonly<Record<number, string>>;
}

/** The fake's USD rate: prices are kept in USD and shown in so'm at this rate (owner 2026-10-29). */
export const FAKE_USD_RATE = '12650';

/** A seed's so'm price as the USD price the fake list keeps (cents, half up). */
export function seedUsd(uzs: string): string {
  const [whole = '0', fraction = ''] = uzs.split('.');
  const tiyin = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
  const rate = BigInt(FAKE_USD_RATE);
  const cents = (tiyin + rate / 2n) / rate;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const FAKE_PUBLISHED_AUTHOR = 'Fake Pricing Manager';
export const FAKE_CURRENT_ACTOR = 'Fake Pricing Admin';

/** Versions 12 and 13 are archived, 14 is the published one (like "Narx ro'yxati v14"). */
export const FAKE_VERSION_NUMBERS = { first: 12, second: 13, published: 14 } as const;

export const FAKE_CATEGORIES = {
  phones: 'Telefonlar',
  accessories: 'Aksessuarlar',
  audio: 'Audio',
  tv: 'Televizorlar',
  tablets: 'Planshetlar',
} as const;

const same = (name: string): Readonly<Record<Locale, string>> => ({
  UZ: name,
  RU: name,
  EN: name,
});

function seed(
  productCode: string,
  category: string | null,
  names: Readonly<Record<Locale, string>>,
  prices: Readonly<Record<number, string>>,
  extra: { isActive?: boolean } = {},
): FakeProductSeed {
  return {
    productCode,
    category,
    isActive: extra.isActive ?? true,
    names,
    prices,
  };
}

const { phones, accessories, audio, tv, tablets } = FAKE_CATEGORIES;

// Names and prices match the products inside the demo orders (fake-backoffice-fixtures), so the
// price list and the orders tell the same story. Codes are 5-digit like the real sheet's.
export const FAKE_PRODUCT_SEEDS: readonly FakeProductSeed[] = [
  seed(
    '10482',
    accessories,
    {
      UZ: 'Baseus Type-C kabel 1 m',
      RU: 'Кабель Baseus Type-C 1 м',
      EN: 'Baseus Type-C cable 1 m',
    },
    { 12: '29000.00', 13: '30000.00', 14: '32000.00' },
  ),
  seed(
    '10483',
    accessories,
    {
      UZ: 'Samsung 25W zaryadlovchi',
      RU: 'Зарядное устройство Samsung 25W',
      EN: 'Samsung 25W charger',
    },
    { 12: '149000.00', 13: '149000.00', 14: '145000.00' },
  ),
  seed('10484', audio, same('Xiaomi Redmi Buds 5'), { 13: '269000.00', 14: '279000.00' }),
  seed('10485', accessories, same('Anker PowerCore 20000'), {
    12: '369000.00',
    13: '379000.00',
    14: '389000.00',
  }),
  seed(
    '10486',
    accessories,
    { UZ: 'Himoya oynasi 9H', RU: 'Защитное стекло 9H', EN: 'Screen protector 9H' },
    { 12: '8000.00', 13: '8000.00', 14: '9000.00' },
  ),
  seed(
    '10487',
    accessories,
    {
      UZ: "Galaxy A15 silikon g'ilof",
      RU: 'Силиконовый чехол для Galaxy A15',
      EN: 'Silicone case for Galaxy A15',
    },
    { 14: '18000.00' },
  ),
  seed('10488', audio, same('Samsung Galaxy Buds FE'), { 13: '990000.00', 14: '990000.00' }),
  seed(
    '10489',
    audio,
    { UZ: 'JBL Go 3 kolonka', RU: 'Колонка JBL Go 3', EN: 'JBL Go 3 speaker' },
    { 12: '329000.00', 13: '339000.00', 14: '349000.00' },
  ),
  seed('10490', phones, same('Xiaomi Redmi 13C 4/128GB'), { 14: '1290000.00' }),
  seed('10491', phones, same('Samsung Galaxy A15 4/128GB'), { 14: '1690000.00' }),
  seed('10492', phones, same('Samsung Galaxy A25 6/128GB'), {
    12: '2490000.00',
    13: '2490000.00',
    14: '2590000.00',
  }),
  // In the published list but deactivated afterwards: copying it into a draft makes publish
  // fail with the "inactive product" conflict, which the screens must explain.
  seed(
    '10493',
    accessories,
    {
      UZ: 'Samsung 5W zaryadlovchi (eski)',
      RU: 'Зарядное устройство Samsung 5W (старое)',
      EN: 'Samsung 5W charger (old)',
    },
    { 12: '65000.00', 13: '65000.00', 14: '65000.00' },
    { isActive: false },
  ),
  // Not in any price list yet (shown on the "no price yet" tab, and in the editor's picker).
  seed('10494', tablets, same('Samsung Galaxy Tab A9 64GB'), {}),
  seed('10495', phones, same('Samsung Galaxy A55 8/256GB'), { 14: '4890000.00' }),
  seed('10496', phones, same('Xiaomi Redmi Note 13 8/256GB'), { 14: '2950000.00' }),
  seed('10497', phones, same('Apple iPhone 15 128GB'), { 14: '9850000.00' }),
  seed('10498', tv, same('TCL 55" 4K QLED TV'), { 14: '6290000.00' }),
  // Priced, but no delivery in the sheet yet: no cost, no stock aggregate and no category.
  seed('10499', null, same('Samsung 43" Crystal UHD TV'), { 14: '4390000.00' }),
  // Created from the sheet by the sync: no price and no code rule set yet.
  seed('10521', tablets, same('Xiaomi Redmi Pad SE 4/128GB'), {}),
  seed(
    '10522',
    accessories,
    {
      UZ: 'Baseus 65W GaN zaryadlovchi',
      RU: 'Зарядное устройство Baseus 65W GaN',
      EN: 'Baseus 65W GaN charger',
    },
    {},
  ),
  seed('10523', audio, same('Xiaomi Smart Band 9'), {}),
  seed('10524', phones, same('Apple iPhone 14 128GB'), {}),
  seed('10525', null, same('Naqd kassa lenta 80 mm'), {}),
];

/**
 * The per-unit code rule of a demo product ([C] 2026-10-25); the products listed have a configured
 * rule, the others never had one set (the editor suggests the company rule for them).
 */
export interface FakeCodeRuleSeed {
  readonly trackingType: 'IMEI' | 'SERIAL';
  readonly markingRequired: boolean;
}

const PHONE_RULE: FakeCodeRuleSeed = { trackingType: 'IMEI', markingRequired: true };
const SERIAL_RULE: FakeCodeRuleSeed = { trackingType: 'SERIAL', markingRequired: false };

/** By product code: phones carry IMEI + a marking code, TVs and tablets a serial number. */
export const FAKE_CODE_RULES: Readonly<Record<string, FakeCodeRuleSeed>> = {
  '10490': PHONE_RULE,
  '10491': PHONE_RULE,
  '10492': PHONE_RULE,
  '10495': PHONE_RULE,
  '10496': PHONE_RULE,
  '10497': PHONE_RULE,
  '10524': PHONE_RULE,
  '10494': SERIAL_RULE,
  '10498': SERIAL_RULE,
  '10499': SERIAL_RULE,
  '10521': SERIAL_RULE,
};

/**
 * Staff product categories (templates of the code rule). A product whose sheet category has the
 * same name is linked to it; `archived` shows the restore action.
 */
export const FAKE_PRODUCT_CATEGORY_SEEDS: readonly {
  readonly name: string;
  readonly trackingTypeDefault: 'NONE' | 'IMEI' | 'SERIAL';
  readonly markingRequiredDefault: boolean;
  readonly archived?: boolean;
}[] = [
  { name: FAKE_CATEGORIES.phones, trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
  { name: FAKE_CATEGORIES.tv, trackingTypeDefault: 'SERIAL', markingRequiredDefault: false },
  { name: FAKE_CATEGORIES.accessories, trackingTypeDefault: 'NONE', markingRequiredDefault: false },
  {
    name: 'Eski aksessuarlar',
    trackingTypeDefault: 'NONE',
    markingRequiredDefault: false,
    archived: true,
  },
];
