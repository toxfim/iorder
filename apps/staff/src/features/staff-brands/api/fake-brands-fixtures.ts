// Demo data of the fake brands backend (dev and tests only; check:bundle keeps it out of a
// production build by the marker and the fixture names below).

export const FAKE_BRANDS_BACKEND_MARKER = 'iorder-fake-brands-backend';

export const FAKE_BRAND_NAMES: readonly string[] = [
  'Apple',
  'Samsung',
  'Xiaomi',
  'Huawei',
  'Honor',
  'JBL',
  'Anker',
  'Artel',
];

export interface FakeUnbrandedSeed {
  readonly productCode: string;
  readonly name: string;
  readonly category: string | null;
  readonly priced: boolean;
}

// Names in which the brand finder sees no known brand (a sub-brand, a model name only).
export const FAKE_UNBRANDED_SEEDS: readonly FakeUnbrandedSeed[] = [
  { productCode: 'FB-6I-BLK', name: 'FreeBuds 6i Black', category: 'Quloqchinlar', priced: true },
  {
    productCode: 'MI-RE-PRO-CE',
    name: 'Mi Wi-Fi Range Extender Pro CE',
    category: 'Tarmoq qurilmalari',
    priced: true,
  },
  {
    productCode: 'RDM-15C-8-256',
    name: 'Redmi 15C 8/256GB Midnight Black',
    category: 'Telefonlar',
    priced: false,
  },
  { productCode: 'MG-PB-10K', name: 'MagGo Power Bank 10000 mAh', category: null, priced: false },
  { productCode: 'EB-2-WHT', name: 'Echo Buds 2 White', category: 'Quloqchinlar', priced: false },
];

/** Groups the fake "sends" the price list to. */
export const FAKE_POSTING_GROUP_COUNT = 3;
