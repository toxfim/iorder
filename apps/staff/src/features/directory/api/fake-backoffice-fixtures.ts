import type { OrderStatus, PaymentStatus, StaffRole } from '@iorder/shared';
import { fakeUuid } from '@core/lib/fake-ids';
import type { MemberView, OrganizationView } from '../domain/directory-model';

// Sample back-office data for the in-memory fake (dev, tests, VITE_USE_FAKE_API). Names, amounts
// and statuses come from docs/private/design/v1 (Dashboard v5, seed()). This module must never reach a
// production bundle: scripts/check-bundle.mjs looks for these names.

export const FAKE_BACKOFFICE_MARKER = 'iorder-fake-backoffice';

const iso = (date: string): string => `${date}T08:00:00.000Z`;

export const FAKE_ORGANIZATIONS: readonly OrganizationView[] = [
  {
    id: fakeUuid('org-orion-mobile'),
    name: 'Orion Mobile',
    type: 'GROUP',
    address: "Toshkent, Chilonzor, Bunyodkor ko'chasi 12",
    phone: '+998903512210',
    telegramGroup: '@idealmobile_opt',
    isActive: true,
    since: iso('2026-03-01'),
  },
  {
    id: fakeUuid('org-mobile-center'),
    name: 'Mobile Center Samarqand',
    type: 'GROUP',
    address: "Samarqand, Registon ko'chasi 45",
    phone: '+998915401877',
    telegramGroup: '@mcsamarqand',
    isActive: true,
    since: iso('2026-04-01'),
  },
  {
    id: fakeUuid('org-texno-market'),
    name: 'Texno Market Andijon',
    type: 'GROUP',
    address: "Andijon, Navoiy shoh ko'chasi 8",
    phone: '+998932206104',
    telegramGroup: '@texnomarket_and',
    isActive: true,
    since: iso('2026-05-01'),
  },
  {
    id: fakeUuid('org-gsm-plus'),
    name: 'GSM Plus',
    type: 'GROUP',
    address: 'Toshkent, Chilonzor 9-kvartal, 3A',
    phone: '+998977159032',
    telegramGroup: '@gsmplus_uz',
    isActive: true,
    since: iso('2026-06-01'),
  },
  {
    id: fakeUuid('org-click-store'),
    name: 'Click Store',
    type: 'GROUP',
    address: 'Toshkent, Yunusobod 4-mavze, 17',
    phone: '+998998024415',
    telegramGroup: '@clickstore_tsh',
    isActive: true,
    since: iso('2026-07-01'),
  },
  {
    id: fakeUuid('org-smart-zone'),
    name: 'Smart Zone Namangan',
    type: 'GROUP',
    address: "Namangan, Uychi ko'chasi 21",
    phone: '+998953001245',
    telegramGroup: '@smartzone_nam',
    isActive: false,
    since: iso('2026-08-01'),
  },
];

export const FAKE_MEMBERS: readonly MemberView[] = [
  {
    id: fakeUuid('u-101'),
    organizationId: fakeUuid('org-orion-mobile'),
    name: 'Jasur Karimov',
    phone: '+998903512210',
    telegramUsername: '@jasur_k',
    role: 'SHOP_OWNER',
    isActive: true,
    joinedAt: iso('2026-03-12'),
  },
  {
    id: fakeUuid('u-102'),
    organizationId: fakeUuid('org-orion-mobile'),
    name: 'Dilnoza Rahimova',
    phone: '+998907741052',
    telegramUsername: '@dilnoza_r',
    role: 'SELLER',
    isActive: true,
    joinedAt: iso('2026-03-14'),
  },
  {
    id: fakeUuid('u-103'),
    organizationId: fakeUuid('org-orion-mobile'),
    name: 'Bobur Aliyev',
    phone: '+998946103308',
    telegramUsername: '@bobur_a',
    role: 'SELLER',
    isActive: true,
    joinedAt: iso('2026-06-02'),
  },
  {
    id: fakeUuid('u-111'),
    organizationId: fakeUuid('org-mobile-center'),
    name: 'Akmal Nurmatov',
    phone: '+998915401877',
    telegramUsername: '@akmal_mc',
    role: 'SHOP_OWNER',
    isActive: true,
    joinedAt: iso('2026-04-08'),
  },
  {
    id: fakeUuid('u-112'),
    organizationId: fakeUuid('org-mobile-center'),
    name: 'Lola Saidova',
    phone: '+998912034490',
    telegramUsername: '@lola_s',
    role: 'SELLER',
    isActive: true,
    joinedAt: iso('2026-04-10'),
  },
  {
    id: fakeUuid('u-121'),
    organizationId: fakeUuid('org-texno-market'),
    name: 'Otabek Mirzayev',
    phone: '+998932206104',
    telegramUsername: '@otabek_tm',
    role: 'SHOP_OWNER',
    isActive: true,
    joinedAt: iso('2026-05-03'),
  },
  {
    id: fakeUuid('u-131'),
    organizationId: fakeUuid('org-gsm-plus'),
    name: 'Javlon Sobirov',
    phone: '+998977159032',
    telegramUsername: '@javlon_gsm',
    role: 'SELLER',
    isActive: true,
    joinedAt: iso('2026-06-11'),
  },
  {
    id: fakeUuid('u-132'),
    organizationId: fakeUuid('org-gsm-plus'),
    name: 'Kamola Ergasheva',
    phone: '+998971182561',
    telegramUsername: '@kamola_e',
    role: 'SELLER',
    isActive: false,
    joinedAt: iso('2026-06-11'),
  },
  {
    id: fakeUuid('u-141'),
    organizationId: fakeUuid('org-click-store'),
    name: 'Sardor Ergashev',
    phone: '+998998024415',
    telegramUsername: '@sardor_cs',
    role: 'SHOP_OWNER',
    isActive: true,
    joinedAt: iso('2026-07-01'),
  },
  {
    id: fakeUuid('u-151'),
    organizationId: fakeUuid('org-smart-zone'),
    name: 'Ulugʻbek Haydarov',
    phone: '+998953001245',
    telegramUsername: '@ulugbek_sz',
    role: 'SHOP_OWNER',
    isActive: false,
    joinedAt: iso('2026-08-20'),
  },
];

/** Directory-only demo data (the orders and staff-users fakes do not know it): a PERSON customer. */
export const FAKE_DIRECTORY_ONLY_ORGANIZATIONS: readonly OrganizationView[] = [
  {
    id: fakeUuid('org-person-nodir'),
    name: 'Nodir Qosimov',
    type: 'PERSON',
    address: '',
    phone: '+998901230077',
    telegramGroup: '',
    isActive: true,
    since: iso('2026-10-05'),
  },
];

export const FAKE_DIRECTORY_ONLY_MEMBERS: readonly MemberView[] = [
  {
    id: fakeUuid('u-161'),
    organizationId: fakeUuid('org-person-nodir'),
    name: 'Nodir Qosimov',
    phone: '+998901230077',
    telegramUsername: '@nodir_q',
    role: 'SHOP_OWNER',
    isActive: true,
    joinedAt: iso('2026-10-05'),
  },
];

/** The company's people as the fake orders backend needs them (drivers, who approved what). */
export interface FakeStaffPerson {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly roles: readonly StaffRole[];
  readonly isActive: boolean;
}

export const FAKE_STAFF: readonly FakeStaffPerson[] = [
  {
    id: fakeUuid('s-01'),
    name: 'Sanjar Toshev',
    phone: '+998909007788',
    roles: ['ADMIN', 'MANAGER'],
    isActive: true,
  },
  {
    id: fakeUuid('s-02'),
    name: 'Aziza Yusupova',
    phone: '+998909001122',
    roles: ['MANAGER'],
    isActive: true,
  },
  {
    id: fakeUuid('s-03'),
    name: 'Malika Usmonova',
    phone: '+998909009900',
    roles: ['MANAGER'],
    isActive: false,
  },
  {
    id: fakeUuid('s-04'),
    name: 'Nodira Xasanova',
    phone: '+998909003344',
    roles: ['ACCOUNTANT'],
    isActive: true,
  },
  {
    id: fakeUuid('s-05'),
    name: 'Rustam Qodirov',
    phone: '+998909005566',
    roles: ['WAREHOUSE_MANAGER'],
    isActive: true,
  },
  {
    id: fakeUuid('s-06'),
    name: 'Bekzod Tursunov',
    phone: '+998901234567',
    roles: ['DRIVER'],
    isActive: true,
  },
  {
    id: fakeUuid('s-07'),
    name: 'Sherzod Aliyev',
    phone: '+998934567890',
    roles: ['DRIVER'],
    isActive: true,
  },
];

/** Products on the order lines: id -> [name, unit price in so'm]. */
export const FAKE_ORDER_PRODUCTS: Readonly<Record<number, readonly [string, string]>> = {
  1: ['Samsung Galaxy A15 4/128GB', '1690000.00'],
  2: ['Samsung Galaxy A25 6/128GB', '2590000.00'],
  3: ['Samsung Galaxy A55 8/256GB', '4890000.00'],
  4: ['Xiaomi Redmi Note 13 8/256GB', '2950000.00'],
  5: ['Xiaomi Redmi 13C 4/128GB', '1290000.00'],
  6: ['Apple iPhone 15 128GB', '9850000.00'],
  7: ['Samsung 25W zaryadlovchi', '145000.00'],
  8: ['Anker PowerCore 20000', '389000.00'],
  10: ['Baseus Type-C kabel 1 m', '32000.00'],
  11: ["Galaxy A15 silikon g'ilof", '18000.00'],
  12: ['Himoya oynasi 9H', '9000.00'],
  13: ['Xiaomi Redmi Buds 5', '279000.00'],
  14: ['JBL Go 3 kolonka', '349000.00'],
  15: ['Samsung Galaxy Buds FE', '990000.00'],
  16: ['Samsung 43" Crystal UHD TV', '4390000.00'],
  17: ['TCL 55" 4K QLED TV', '6290000.00'],
};

export interface FakeOrderSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly placedBy: string;
  readonly lines: readonly (readonly [number, number])[];
  readonly paymentStatus: PaymentStatus;
  readonly status: OrderStatus;
  readonly skipAccounting?: boolean;
  /** Business days before "now" and the Tashkent wall time. */
  readonly daysAgo: number;
  readonly time: string;
}

export const FAKE_ORDER_SEEDS: readonly FakeOrderSeed[] = [
  {
    id: 'IO-10491',
    organizationId: fakeUuid('org-orion-mobile'),
    placedBy: fakeUuid('u-101'),
    lines: [
      [1, 10],
      [7, 30],
      [10, 50],
      [11, 40],
    ],
    paymentStatus: 'UNPAID',
    status: 'SUBMITTED',
    daysAgo: 0,
    time: '09:12',
  },
  {
    id: 'IO-10490',
    organizationId: fakeUuid('org-mobile-center'),
    placedBy: fakeUuid('u-111'),
    lines: [
      [4, 15],
      [5, 20],
      [13, 25],
    ],
    paymentStatus: 'UNPAID',
    status: 'SUBMITTED',
    daysAgo: 0,
    time: '08:55',
  },
  {
    id: 'IO-10489',
    organizationId: fakeUuid('org-texno-market'),
    placedBy: fakeUuid('u-121'),
    lines: [
      [2, 12],
      [8, 20],
    ],
    paymentStatus: 'UNPAID',
    status: 'MANAGER_APPROVED',
    daysAgo: 1,
    time: '17:05',
  },
  {
    id: 'IO-10488',
    organizationId: fakeUuid('org-orion-mobile'),
    placedBy: fakeUuid('u-102'),
    lines: [
      [6, 3],
      [12, 100],
      [10, 60],
    ],
    paymentStatus: 'PAID',
    status: 'RELEASED',
    daysAgo: 2,
    time: '11:20',
  },
  {
    id: 'IO-10487',
    organizationId: fakeUuid('org-click-store'),
    placedBy: fakeUuid('u-141'),
    lines: [
      [16, 4],
      [17, 2],
    ],
    paymentStatus: 'UNPAID',
    status: 'SUBMITTED',
    daysAgo: 1,
    time: '19:30',
  },
  {
    id: 'IO-10486',
    organizationId: fakeUuid('org-gsm-plus'),
    placedBy: fakeUuid('u-131'),
    lines: [
      [3, 5],
      [15, 10],
    ],
    paymentStatus: 'PAID',
    status: 'MANAGER_APPROVED',
    daysAgo: 3,
    time: '16:20',
  },
  {
    id: 'IO-10484',
    organizationId: fakeUuid('org-click-store'),
    placedBy: fakeUuid('u-141'),
    lines: [
      [14, 10],
      [13, 15],
    ],
    paymentStatus: 'UNPAID',
    status: 'ACCOUNTING_CLEARED',
    skipAccounting: true,
    daysAgo: 3,
    time: '10:15',
  },
  {
    id: 'IO-10480',
    organizationId: fakeUuid('org-texno-market'),
    placedBy: fakeUuid('u-121'),
    lines: [
      [1, 20],
      [7, 50],
    ],
    paymentStatus: 'PAID',
    status: 'RELEASED',
    daysAgo: 4,
    time: '09:30',
  },
  {
    id: 'IO-10477',
    organizationId: fakeUuid('org-mobile-center'),
    placedBy: fakeUuid('u-111'),
    lines: [[16, 3]],
    paymentStatus: 'UNPAID',
    status: 'DELIVERED',
    daysAgo: 5,
    time: '12:00',
  },
  {
    id: 'IO-10472',
    organizationId: fakeUuid('org-orion-mobile'),
    placedBy: fakeUuid('u-101'),
    lines: [
      [3, 6],
      [13, 20],
    ],
    paymentStatus: 'UNPAID',
    status: 'DELIVERED',
    daysAgo: 5,
    time: '10:02',
  },
  {
    id: 'IO-10470',
    organizationId: fakeUuid('org-gsm-plus'),
    placedBy: fakeUuid('u-131'),
    lines: [[2, 8]],
    paymentStatus: 'UNPAID',
    status: 'RECEIVED',
    daysAgo: 6,
    time: '09:40',
  },
  {
    id: 'IO-10455',
    organizationId: fakeUuid('org-orion-mobile'),
    placedBy: fakeUuid('u-102'),
    lines: [
      [5, 30],
      [10, 100],
    ],
    paymentStatus: 'PAID',
    status: 'RECEIVED',
    daysAgo: 9,
    time: '11:00',
  },
];

/** The five entries the v1 feed starts with (`at` is a Tashkent time on today's date). */
export const FAKE_ACTIVITY_SEEDS = [
  { time: '09:20', kind: 'ORDER_APPROVED', params: { orderId: 'IO-10489' } },
  {
    time: '09:12',
    kind: 'ORDER_CREATED',
    params: { orderId: 'IO-10491', organization: 'Orion Mobile' },
  },
  { time: '09:02', kind: 'ORDER_APPROVED', params: { orderId: 'IO-10486' } },
  {
    time: '08:55',
    kind: 'ORDER_CREATED',
    params: { orderId: 'IO-10490', organization: 'Mobile Center Samarqand' },
  },
  {
    time: '08:40',
    kind: 'ORDER_RELEASED',
    params: { orderId: 'IO-10488', driver: 'Bekzod Tursunov' },
  },
] as const;

/** Comments customers left when ordering (shown on the order page). */
export const FAKE_CUSTOMER_COMMENTS: Readonly<Record<string, string>> = {
  'IO-10491': 'Iltimos, ertaga ertalab yetkazib bering.',
  'IO-10489': "Qadoqlash alohida bo'lsin.",
};
