import {
  CART_LINE_PROBLEMS,
  ORDER_STATUSES,
  PAYMENT_PLANS,
  PAYMENT_STATUSES,
} from '@iorder/shared';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreMessages } from '@core/i18n';
import { en } from '@/i18n/messages/en';
import { ru } from '@/i18n/messages/ru';
import { uz } from '@/i18n/messages/uz';
import {
  CUSTOMER_ORDER_STATES,
  HISTORY_KINDS,
  stateHintKey,
  stateLabelKey,
  stateNoteKey,
} from '@/features/customer-orders/domain/order-display';

// Hard rule 7 on the sources of the customer Mini App (the bundle check proves it on the build):
// the customer features import no staff entry, no staff feature and no cost vocabulary, and every
// text they ask i18n for exists in all three languages.
const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CUSTOMER_DIRS = [
  'customer-app',
  'customer-cart',
  'customer-catalog',
  'customer-orders',
  'customer-session',
];
const FAKE_FILE = /fake-customer-|customer-boundary\.test|\.test\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|vue)$/.test(name)) yield path;
  }
}

const files = CUSTOMER_DIRS.flatMap((dir) => [...sources(join(src, 'features', dir))]).map(
  (file) => ({ path: relative(src, file).split(sep).join('/'), text: readFileSync(file, 'utf8') }),
);
const shipped = files.filter((file) => !FAKE_FILE.test(file.path));

describe('customer features stay clear of staff code', () => {
  it('finds the sources (the scan itself works)', () => {
    expect(shipped.length).toBeGreaterThan(30);
  });

  it('import no staff contract entry and no staff feature', () => {
    const FORBIDDEN =
      /['"]@iorder\/shared\/staff|['"]@\/features\/(?:staff-|directory|dashboard|search|activity)/;
    expect(files.filter((file) => FORBIDDEN.test(file.text)).map((f) => f.path)).toEqual([]);
  });

  it('contain no cost or staff-order vocabulary', () => {
    const VOCABULARY =
      /costUsd|usdRateUsed|costUzs|deliveredQuantity|accountingMode|SKIPPED_BY_MANAGER|priceListVersionId|deliveryContact|\/staff\//;
    expect(shipped.filter((file) => VOCABULARY.test(file.text)).map((f) => f.path)).toEqual([]);
  });

  it('never loads the Telegram web-app script or builds money with floats', () => {
    const SCRIPT_LOADER = /telegram\.org\/js|createElement\(\s*['"]script/i;
    expect(shipped.filter((f) => SCRIPT_LOADER.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(
      shipped
        .filter((f) => /parseFloat|Number\(\s*[a-z.]*(price|amount|total)/i.test(f.text))
        .map((f) => f.path),
    ).toEqual([]);
  });
});

function flatten(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === 'string') out.set(prefix, node);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      for (const [k, v] of flatten(value, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  }
  return out;
}

describe('customer texts', () => {
  const catalogs = {
    uz: flatten({ ...coreMessages.uz, ...uz }),
    ru: flatten({ ...coreMessages.ru, ...ru }),
    en: flatten({ ...coreMessages.en, ...en }),
  };

  it('every literal key used by the customer features exists in uz, ru and en', () => {
    const used = new Set<string>();
    for (const file of shipped) {
      for (const match of file.text.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
        used.add(match[1] as string);
      }
      for (const match of file.text.matchAll(
        /(?:labelKey|titleKey):\s*['"]([A-Za-z0-9_.]+)['"]/g,
      )) {
        used.add(match[1] as string);
      }
    }
    expect(used.size).toBeGreaterThan(30);
    for (const [name, flat] of Object.entries(catalogs)) {
      const missing = [...used].filter((key) => !flat.has(key));
      expect(missing, `missing in ${name}`).toEqual([]);
    }
  });

  it('has a text for every customer state, history row, payment status, plan and cart problem', () => {
    // Keys built at run time (template strings), which the literal-key scan above cannot see.
    const needed = [
      ...CUSTOMER_ORDER_STATES.map((s) => `customer.orderState.${s}`),
      ...ORDER_STATUSES.flatMap((s) => [stateLabelKey(s), stateHintKey(s)]),
      ...ORDER_STATUSES.map(stateNoteKey).filter((key) => key !== null),
      ...HISTORY_KINDS.map((k) => `customer.order.history.${k}`),
      ...PAYMENT_STATUSES.map((p) => `customer.orders.payment.${p}`),
      ...PAYMENT_PLANS.map((p) => `customer.plan.${p}`),
      ...CART_LINE_PROBLEMS.map((p) => `customer.cart.problem.${p}`),
    ];
    for (const [name, flat] of Object.entries(catalogs)) {
      expect(
        needed.filter((key) => !flat.has(key)),
        `missing in ${name}`,
      ).toEqual([]);
    }
  });

  it('names the three customer states as the owner chose them (order-lifecycle.md 2.1)', () => {
    const label = (state: string) => catalogs.uz.get(`customer.orderState.${state}`);
    expect(label('ACCEPTED')).toBe('Qabul qilindi');
    expect(label('DELIVERED')).toBe('Yetkazib berildi');
    expect(label('REFUSED')).toBe('Rad etildi');
  });

  it.each(['uz', 'ru', 'en'] as const)('the three states read differently (%s)', (lang) => {
    const labels = CUSTOMER_ORDER_STATES.map((s) => catalogs[lang].get(`customer.orderState.${s}`));
    expect(new Set(labels).size).toBe(CUSTOMER_ORDER_STATES.length);
  });

  // The customer side gets no bot message when an order is delivered (owner rule 2026-11-09 on
  // customer bot messages), so the sentence under "accepted" must not promise one.
  it.each([
    ['uz', uz, /xabar/i],
    ['ru', ru, /сообщ|напиш/i],
    ['en', en, /notify|let you know|message|write/i],
  ] as const)('the "accepted" hint promises no message about the delivery (%s)', (_l, c, words) => {
    expect(c.customer.orderState.hint.ACCEPTED).not.toMatch(words);
  });

  // The per-status labels, the progress texts and the staff role names are gone with the internal
  // steps; a key coming back under another name would bring the vocabulary back with it.
  it.each([
    ['uz', uz, /buxgalter|ombordan|haydovchi|menejer tasdiqladi/i],
    ['ru', ru, /бухгалтер|склад|водител|подтверждён менеджером/i],
    ['en', en, /account(ing|ant)|warehouse|driver|approved by/i],
  ] as const)('no customer text names a step inside the company (%s)', (_lang, catalog, words) => {
    const texts = [...flatten(catalog.customer)];
    expect(texts.filter(([, text]) => words.test(text)).map(([key]) => key)).toEqual([]);
    const keys = texts.map(([key]) => key);
    expect(keys.filter((key) => /^(status|role)\.|progress|orderSummary/.test(key))).toEqual([]);
  });
});

// [C, owner 2026-11-09]: a product staff added without a sheet id is brought when an order
// arrives ("buyurtma orqali"). That is for staff only: the customer must never learn that a
// product is of this type. The api proves it on the responses; this proves it on the app.
describe('the customer app never names the product type', () => {
  const everything = [...sources(src)]
    .filter((file) => !file.endsWith('customer-boundary.test.ts'))
    .map((file) => ({
      path: relative(src, file).split(sep).join('/'),
      text: readFileSync(file, 'utf8'),
    }));

  it('no source file reads a type flag or prints the staff word, fakes and tests included', () => {
    const TYPE =
      /stockTracked|codeGenerated|sheetMatch|mergedIntoProductId|byOrder|buyurtma orqali|под заказ/i;
    expect(everything.length).toBeGreaterThan(shipped.length);
    expect(everything.filter((file) => TYPE.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  it.each(['uz', 'ru', 'en'] as const)('%s: no customer or shared text says it', (lang) => {
    const catalog = flatten({ ...coreMessages[lang], ...{ uz, ru, en }[lang] });
    // "by order number" is the order search; anything else about bringing goods by order is not.
    const WORDING =
      /buyurtma orqali|под заказ|by order(?! number)|made to order|kuzatilmaydi|не отслеживается|not tracked/i;
    expect(catalog.size).toBeGreaterThan(50);
    expect([...catalog].filter(([, text]) => WORDING.test(text)).map(([key]) => key)).toEqual([]);
  });
});
