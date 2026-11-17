// The production bundle rules of both web apps (fake-adapter data, Telegram scripts, staff-only
// vocabulary). Each app's scripts/check-bundle.mjs runs them after a normal `vite build` (no
// VITE_USE_FAKE_API). The staff app may hold staff vocabulary in chunks named "staff" (its lazy
// areas); the customer app may hold it nowhere and has no such chunk at all (hard rule 7).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const FORBIDDEN = [
  'Sanjar Toshev',
  'Aziza Yusupova',
  'Nodira Xasanova',
  'Rustam Qodirov',
  'Bekzod Tursunov',
  'Jasur Karimov',
  'Dilnoza Rahimova',
  'outsider',
  // Fake back office (orders, customers, staff, activity): marker and fixture names. Not listed:
  // 'Orion Mobile' and 'IO-10491', which are the verbatim v1 example in the search placeholder.
  'iorder-fake-backoffice',
  'Smart Zone Namangan',
  'Sherzod Aliyev',
  'Malika Usmonova',
  'Kamola Ergasheva',
  'Mobile Center Samarqand',
  '@idealmobile_opt',
  'IO-10455',
  'Iltimos, ertaga ertalab',
  'Samsung Galaxy A15 4/128GB',
  // Fake price list backend: its marker and fixture names (features/pricing/api).
  'iorder-fake-price-backend',
  'Fake Pricing Manager',
  'Fake Pricing Admin',
  'Anker PowerCore 20000',
  'Xiaomi Redmi Buds 5',
  'Samsung 5W zaryadlovchi (eski)',
  // Fake cost, stock and sheet-sync backend (features/staff-cost/api): marker and fixture names.
  'iorder-fake-cost-backend',
  'Fake Cost Manager',
  'alpha trade import',
  'Beta system tm fbs',
  'Xiaomi Redmi Pad SE 4/128GB',
  'Baseus 65W GaN zaryadlovchi',
  'Xiaomi Smart Band 9',
  'Naqd kassa lenta 80 mm',
  'SHEET_UNREACHABLE',
  'Samsung Galaxy Tab A9 64GB',
  'Apple iPhone 14 128GB',
  // Fake customer Mini App backend (features/customer-app/api): marker, fixtures and the init
  // data values its dev launch URL accepts.
  'iorder-fake-customer-backend',
  'fake-other-org',
  'fake-inactive-org',
  'Anvar Soliyev',
  'Madina Ismoilova',
  'Otabek Nazarov',
  'Gulnora Aliyeva',
  'Fake Staff Member',
  'Fake Staff Viewer',
  'Fake Staff Tester',
  'fake-viewer',
  'Sinov tashkiloti',
  'Tecno Spark 20 128GB',
  'Baseus 20W zaryadlovchi',
  'Hoco USB-C kabel 1 m',
  'Ugreen 65W GaN adapter',
  'Borofone BW05 quloqchin',
  'Himoya oynasi (Hoco, A15)',
  'Eski 5W zaryadlovchi',
  'Yangi powerbank 10000 mAh',
  'Tecno Pop 8 64GB',
  'Bu model omborda tugagan',
  // Fake organizations backend (features/staff-organizations/api): marker and fixture names.
  'iorder-fake-organizations',
  'Navoiy Elektronika',
  'Chilonzor Gadget',
  'Samarqand Savdo Markazi',
  // Fake dashboard summary backend (features/staff-orders/api): marker.
  'iorder-fake-dashboard-summary',
  // Fake blocking and staff accounts backend (features/staff-users/api): marker and fixture names.
  'iorder-fake-staff-users',
  'Rahmatulla Qosimov',
  'Gulbahor Tojiyeva',
  'Ravshan Haydarov',
  'Mansur Ismoilov',
  'Temur Boboyev',
  'Sardorbek Hamidov',
  // Fake bot notifications (features/staff-notifications/api): the demo bot of its links.
  'iorder_demo_bot',
  // Fake brands and price list file backend (features/staff-brands/api): marker and fixture names.
  'iorder-fake-brands-backend',
  'iorder-fake-product-images',
  'FreeBuds 6i Black',
  'Mi Wi-Fi Range Extender Pro CE',
  'MagGo Power Bank 10000 mAh',
  // Fake by-order products (features/staff-cost/api/fake-by-order): marker and fixture names.
  'iorder-fake-by-order',
  'Ugreen HiTune T6 quloqchin',
  'Baseus Bowie 30 Max naushnik',
  'Yesido avtomobil ushlagichi C192',
  'Remax simsiz zaryadlovchi 15W',
  // Removed demo state switcher (owner request 2026-10-22): its labels must never ship again.
  "Bu sahifa keyingi bosqichda qo'shiladi",
  'Эта страница появится на следующем этапе',
  'This page will be added in a later phase',
];

// Only the signed website Login Widget is allowed, isolated in the lazy website-auth chunk.
// Mini App startup does not mount the widget. Other Telegram script URLs remain forbidden.
const TELEGRAM_SCRIPT = 'telegram.org/js';
const WIDGET_SCRIPT = 'https://telegram.org/js/telegram-widget.js';
const isStaffAuthChunk = (file) => /^(staff-auth|website-auth)/i.test(basename(file));
function telegramScriptHit(file, text) {
  const rest = isStaffAuthChunk(file) ? text.split(WIDGET_SCRIPT).join('') : text;
  return rest.includes(TELEGRAM_SCRIPT);
}

// Hard rule 7: cost contract names and cost route paths must not ship in the customer bundle.
// Allowed only in chunks whose file name contains "staff" (the lazy staff area). A staff cost
// screen must therefore live in a route chunk with "staff" in its name, e.g. StaffCostView.
const COST_FORBIDDEN = [
  'costUsd',
  'usdRateUsed',
  'costUzs',
  'deliveredQuantity',
  '/staff/usd-rate',
  'cost-reference',
  'staff-cost',
];
// Distinctive cost-vocabulary labels of the staff-cost catalogs (features/staff-cost/messages) in
// all three languages. They are loaded lazily into the staff area; one in a non-staff chunk
// means the customer bundle ships them. Non-ASCII text is also checked in its escaped form.
const COST_LABELS = [
  'Tannarx',
  'Yetkazib beruvchi',
  'Себестоимость',
  'Поставщик',
  'Метод закупки',
  'Purchase method',
  'Cost, $',
  'Delivery history',
  'Supplier',
  'Kurs $1 =',
  'Rate $1 =',
];
const escaped = (label) =>
  [...label]
    .map((c) => (c.charCodeAt(0) > 127 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c))
    .join('');
// Staff order contracts (accounting vocabulary, staff DTO keys, staff routes): same rule, no
// exceptions. The back-office orders UI lives in the staff-orders chunk (see vite.config.ts).
const STAFF_ORDER_FORBIDDEN = [
  'priceListVersionId',
  'SKIPPED_BY_MANAGER',
  'deliveryContact',
  'accountingMode',
  'ACCOUNTING_SKIPPED',
  '/staff/orders',
  // Staff website sign-in routes (contract entry @iorder/shared/staff-auth).
  '"/auth/password-login"',
  '"/auth/telegram-widget"',
  // Staff accounts and group removal after a block (entries @iorder/shared/staff-auth and
  // staff-orders): routes and field names.
  '/staff/accounts',
  '/removal-status',
  'removeFromGroups',
  'telegramLinked',
  'hasPassword',
];
// Prose of the staff accounts page and the block dialog (features/staff-users/messages), in all
// three languages. Non-ASCII text is also checked in its escaped form.
const STAFF_USERS_FORBIDDEN = [
  'Guruhdan ham chiqarilsinmi?',
  'Remove from the group too?',
  'Удалить из группы тоже?',
  'Bir martalik parol',
  'One-time password',
  'Одноразовый пароль',
  'Kuchli parol yaratish',
  'Generate a strong password',
];
// Back-office prose that used to sit in the shared catalog: it belongs to the staff-common chunk.
const STAFF_PROSE = [
  'manager approved, straight to the warehouse',
  'менеджер подтвердил, на склад без бухгалтерии',
  'Menejer tasdiqladi, buxgalteriyasiz omborga',
  'Orders awaiting approval',
];
// Staff organizations screens (features/staff-organizations/messages): UI strings in all three
// languages. They are lazy-loaded with the staff area; one in a non-staff chunk means the
// customer bundle ships them. Non-ASCII text is also checked in its escaped form.
const STAFF_ORGANIZATIONS_FORBIDDEN = [
  'Bot added by',
  'Added by staff (not through the bot)',
  "Xodim qo'shgan (bot orqali emas)",
  'Добавлена сотрудником (не через бота)',
];
// "By order" is STAFF vocabulary [C, owner 2026-11-09]: a staff-added product without a sheet id is
// brought when an order arrives, and the customer must never learn that a product is of this type.
// The customer app may hold these labels nowhere. Uzbek and Russian only: the English "by order"
// is too ordinary a phrase ("search by order number") to forbid by text.
const BY_ORDER_LABELS = ['Buyurtma orqali', 'Под заказ'];
const namesStaff = (file) => /staff/i.test(basename(file));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|css|html|map)$/.test(name)) yield path;
  }
}

// Chunks that must never sit on a static import cycle. staff-finance holds the shared cost and
// catalog contracts and is loaded at start-up; when a page chunk it imports imports it back, one
// of them reads a binding before it is initialised and the whole app stays blank (staging,
// 2026-10-28: "Cannot read properties of undefined (reading 'shape')").
const NO_CYCLE_CHUNKS = /^staff-finance-/;
const STATIC_IMPORT =
  /(?:^|[;}\n])\s*import\s*(?:\{[^}]*\}|\*\s*as\s*\w+|\w+)?\s*(?:from\s*)?["']\.\/([^"']+\.js)["']/g;

/** Static import cycles (`a -> b -> a`) that pass through a NO_CYCLE_CHUNKS chunk. */
function importCycles(dist) {
  const graph = new Map();
  for (const file of files(dist)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(file, 'utf8');
    graph.set(basename(file), [...new Set([...text.matchAll(STATIC_IMPORT)].map((m) => m[1]))]);
  }
  const cycles = [];
  for (const start of graph.keys()) {
    if (!NO_CYCLE_CHUNKS.test(start)) continue;
    // Depth-first from the chunk: any path that comes back to it is a cycle.
    const seen = new Set();
    const walk = (node, path) => {
      for (const next of graph.get(node) ?? []) {
        if (next === start) cycles.push([...path, next].join(' -> '));
        else if (!seen.has(next)) {
          seen.add(next);
          walk(next, [...path, next]);
        }
      }
    };
    walk(start, [start]);
  }
  return cycles;
}

const includesText = (text, phrase) => text.includes(phrase) || text.includes(escaped(phrase));

/**
 * Problems found in `dist`. With `staffApp`, chunks named "staff" may hold staff vocabulary;
 * without it no chunk may, and a chunk named "staff" is a problem by itself.
 */
export function findBundleProblems(dist, { staffApp }) {
  const isStaffChunk = (file) => staffApp && namesStaff(file);
  const hits = [];
  for (const file of files(dist)) {
    const text = readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(`${needle} in ${file}`);
    }
    if (telegramScriptHit(file, text)) hits.push(`Telegram script URL in ${file}`);
    if (!staffApp && namesStaff(file)) hits.push(`staff chunk ${file} in the customer app`);
    if (!staffApp) {
      for (const label of BY_ORDER_LABELS) {
        if (includesText(text, label)) hits.push(`by-order label "${label}" in ${file}`);
      }
    }
    if (isStaffChunk(file)) continue;
    for (const needle of COST_FORBIDDEN) {
      if (text.includes(needle)) hits.push(`cost contract name "${needle}" in ${file}`);
    }
    for (const label of COST_LABELS) {
      if (includesText(text, label)) hits.push(`cost label "${label}" in ${file}`);
    }
    for (const phrase of STAFF_PROSE) {
      if (includesText(text, phrase)) hits.push(`staff prose "${phrase}" in ${file}`);
    }
    for (const phrase of STAFF_ORGANIZATIONS_FORBIDDEN) {
      if (includesText(text, phrase)) {
        hits.push(`staff organizations text "${phrase}" in ${file}`);
      }
    }
    for (const phrase of STAFF_USERS_FORBIDDEN) {
      if (includesText(text, phrase)) hits.push(`staff accounts text "${phrase}" in ${file}`);
    }
    for (const needle of STAFF_ORDER_FORBIDDEN) {
      if (text.includes(needle)) hits.push(`staff order vocabulary "${needle}" in ${file}`);
    }
  }

  for (const cycle of importCycles(dist)) hits.push(`static import cycle: ${cycle}`);

  // The cost code lives in staff chunks that only the lazy staff routes load. If index.html (the
  // entry and its preloads) references one, everyone who opens the login page downloads it.
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
    if (namesStaff(asset)) hits.push(`staff chunk ${asset} is loaded by index.html`);
  }
  return hits;
}

/** The body of each app's check-bundle script: prints the result and sets the exit code. */
export function runBundleCheck(dist, options) {
  const hits = findBundleProblems(dist, options);
  if (hits.length > 0) {
    console.error('Production bundle check failed:\n' + hits.join('\n'));
    process.exit(1);
  }
  console.log('check-bundle: no fake-adapter data or misplaced staff vocabulary found in dist');
}
