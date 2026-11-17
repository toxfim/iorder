import type { OrganizationRole, StaffRole, StaffViewerInfo } from '@iorder/shared';
import { fakeUuid } from '@core/lib/fake-ids';

// Fixtures of the fake customer backend. Only ever loaded through the dev/flag gate (see
// create-customer-services.ts); scripts/check-bundle.mjs fails the production build if any of
// these names appears in it.

export const FAKE_CUSTOMER_BACKEND_MARKER = 'iorder-fake-customer-backend';

export interface FakeProduct {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Null: the product is not in the published price list. */
  readonly price: string | null;
  /** The pay-in-parts price; null: none, so a cart with this product cannot choose that plan. */
  readonly deferredPrice: string | null;
  /** The recommended retail price of one piece; null: none, the cart then shows nothing for it. */
  readonly rrp: string | null;
  /** The raw sheet label (Russian in the real data); null = no category. */
  readonly category: string | null;
  readonly active: boolean;
  /**
   * How many whole pieces can be ordered now, like the server's answer: 0 = out of stock (cannot
   * be ordered), null = no figure and no cap (the stock is unknown or not tracked).
   */
  readonly stock: number | null;
}

/**
 * Stand-ins for the stored photo variants (thumb <= 256 px, large <= 1200 px): an SVG with the
 * code and the variant written on it, so a demo shows which one a screen loaded. Some products
 * have no photo, like in real data.
 */
const FAKE_PHOTO_HUES: Readonly<Record<string, number>> = {
  'TECNO-SPARK20-128': 210,
  'BASEUS-20W': 30,
  'HOCO-USBC-1M': 150,
  'UGREEN-65W-GAN': 280,
};

export function fakeProductPhoto(code: string, variant: 'thumb' | 'large'): string | null {
  const hue = FAKE_PHOTO_HUES[code];
  if (hue === undefined) return null;
  const size = variant === 'thumb' ? 256 : 1200;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="hsl(${hue} 45% 92%)"/>` +
    `<rect x="32" y="12" width="36" height="70" rx="6" fill="hsl(${hue} 35% 45%)"/>` +
    `<text x="50" y="92" font-size="6" text-anchor="middle" fill="hsl(0 0% 20%)">${code} · ${variant}</text>` +
    '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const product = (
  key: string,
  name: string,
  unit: string,
  price: string | null,
  category: string | null,
  active = true,
  deferredPrice: string | null = null,
  rrp: string | null = null,
  stock: number | null = null,
): FakeProduct => ({
  id: fakeUuid(`customer-product:${key}`),
  code: key,
  name,
  unit,
  price,
  deferredPrice,
  rrp,
  category,
  active,
  stock,
});

/**
 * "Newer model" pairs STAFF confirmed, as the server keeps them (older product -> newer product).
 * Fixtures only: the demo organization received the Baseus charger, so its home shows the hero
 * state with the Ugreen adapter; real pairs are models of one line (Buds 6 -> Buds 8).
 */
export const FAKE_CONFIRMED_SUCCESSIONS: readonly (readonly [older: string, newer: string])[] = [
  ['BASEUS-20W', 'UGREEN-65W-GAN'],
];

export const FAKE_PRODUCTS: readonly FakeProduct[] = [
  product(
    'TECNO-SPARK20-128',
    'Tecno Spark 20 128GB',
    'dona',
    '1650000.00',
    'Смартфоны',
    true,
    '1815000.00',
    '1890000.00',
    12,
  ),
  // Out of stock: shown, toned down, and not orderable until the sheet shows pieces again.
  product(
    'TECNO-POP8-64',
    'Tecno Pop 8 64GB',
    'dona',
    '1150000.00',
    'Смартфоны',
    true,
    null,
    null,
    0,
  ),
  product(
    'BASEUS-20W',
    'Baseus 20W zaryadlovchi',
    'dona',
    '89000.00',
    'Зарядные устройства',
    true,
    '97900.00',
    '109000.00',
    45,
  ),
  product(
    'HOCO-USBC-1M',
    'Hoco USB-C kabel 1 m',
    'dona',
    '18500.00',
    'Кабели',
    true,
    '20350.00',
    '25000.00',
    300,
  ),
  product(
    'UGREEN-65W-GAN',
    'Ugreen 65W GaN adapter',
    'dona',
    '245000.00',
    'Зарядные устройства',
    true,
    '269500.00',
  ),
  product(
    'BOROFONE-BW05',
    'Borofone BW05 quloqchin',
    'quti',
    '112000.00',
    'Аудио',
    true,
    '123200.00',
  ),
  // The two products above have no RRP, like most real ones: their cart lines show none. They
  // also have no stock figure (and so no cap), like the next one: only the first three do.
  // No deferred price: shows the disabled pay-in-parts option in the cart.
  product('HOCO-GLASS-A15', 'Himoya oynasi (Hoco, A15)', 'quti', '36000.00', null),
  // Not orderable: kept for the cart's problem states.
  product('OLD-CHARGER-5W', 'Eski 5W zaryadlovchi', 'dona', null, 'Зарядные устройства', false),
  product('NEW-POWERBANK', 'Yangi powerbank 10000 mAh', 'dona', null, 'Аудио'),
];

export interface FakeAccount {
  readonly id: string;
  /** The init data the fake accepts: send `#tgWebAppData=<this>` in dev. */
  readonly initData: string;
  readonly fullName: string;
  readonly locale: 'UZ' | 'RU' | 'EN';
  readonly staffRoles: readonly StaffRole[];
  readonly organizationId: string | null;
  readonly role: OrganizationRole | null;
  /** Null until the customer has entered a phone at the first order (the fake keeps it in memory). */
  readonly phone: string | null;
  /** Set for a staff member who may use the customer app as a viewer, like the server's `/me`. */
  readonly staffViewer?: StaffViewerInfo;
}

/** The test organization a staff viewer's order is written to in the fake. */
export const FAKE_STAFF_ORDER_ORGANIZATION = 'Sinov tashkiloti';

export const ORG_ACTIVE = fakeUuid('customer-org:texno-plaza');
export const ORG_OTHER = fakeUuid('customer-org:zamon-telecom');
export const ORG_INACTIVE = fakeUuid('customer-org:closed-shop');

const account = (
  initData: string,
  fullName: string,
  organizationId: string | null,
  role: OrganizationRole | null,
  staffRoles: readonly StaffRole[] = [],
  phone: string | null = null,
  staffViewer?: StaffViewerInfo,
): FakeAccount => ({
  id: fakeUuid(`customer-user:${initData}`),
  initData,
  fullName,
  locale: 'UZ',
  staffRoles,
  organizationId,
  role,
  phone,
  ...(staffViewer === undefined ? {} : { staffViewer }),
});

export const FAKE_ACCOUNTS: readonly FakeAccount[] = [
  account('fake-owner', 'Anvar Soliyev', ORG_ACTIVE, 'SHOP_OWNER', [], '+998901112233'),
  account('fake-seller', 'Madina Ismoilova', ORG_ACTIVE, 'SELLER', [], '+998905556677'),
  // A new customer who has not entered a phone yet: the first order asks for it.
  account('fake-newcomer', 'Dilshod Karimov', ORG_ACTIVE, 'SELLER'),
  // Another organization: proves that a foreign order is a 404.
  account('fake-other-org', 'Otabek Nazarov', ORG_OTHER, 'SHOP_OWNER', [], '+998907778899'),
  // A member of an organization that is not active: the server treats them as no member.
  account('fake-inactive-org', 'Gulnora Aliyeva', ORG_INACTIVE, 'SHOP_OWNER'),
  // A staff member whose role does not open the customer app (the warehouse and the driver never
  // see a price): signed in, but turned away like anyone who is not a customer.
  account('fake-staff', 'Fake Staff Member', null, null, ['DRIVER']),
  // Staff viewers of the customer app: prices and a cart, no organization. The first cannot place
  // an order (production); the second can, into the one test organization (staging).
  account('fake-viewer', 'Fake Staff Viewer', null, null, ['MANAGER'], null, {
    canOrder: false,
    organizationName: null,
  }),
  account('fake-viewer-ordering', 'Fake Staff Tester', null, null, ['ACCOUNTANT'], null, {
    canOrder: true,
    organizationName: FAKE_STAFF_ORDER_ORGANIZATION,
  }),
];

export const ACTIVE_ORGANIZATION_IDS: ReadonlySet<string> = new Set([ORG_ACTIVE, ORG_OTHER]);
