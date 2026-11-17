import { describe, expect, it } from 'vitest';
import { en } from './messages/en';
import { ru } from './messages/ru';
import { uz } from './messages/uz';
import { staffCommonMessages } from '@/features/staff-common/messages';
import { staffCostMessages } from '@/features/staff-cost/messages';
import { staffOrdersMessages } from '@/features/staff-orders/messages';

function flatten(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === 'string') {
    out.set(prefix, node);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      for (const [k, v] of flatten(value, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  }
  return out;
}

// The staff cost and back-office order labels are lazy (hard rule 7) but must stay in key parity
// like the rest.
const uzFlat = flatten({
  ...uz,
  ...staffCommonMessages.uz,
  staffCost: staffCostMessages.uz,
  orders: staffOrdersMessages.uz,
});
const locales = {
  ru: flatten({
    ...ru,
    ...staffCommonMessages.ru,
    staffCost: staffCostMessages.ru,
    orders: staffOrdersMessages.ru,
  }),
  en: flatten({
    ...en,
    ...staffCommonMessages.en,
    staffCost: staffCostMessages.en,
    orders: staffOrdersMessages.en,
  }),
};

describe('message catalogs', () => {
  for (const [name, flat] of Object.entries(locales)) {
    it(`${name} has exactly the same keys as uz`, () => {
      const missing = [...uzFlat.keys()].filter((k) => !flat.has(k));
      const extra = [...flat.keys()].filter((k) => !uzFlat.has(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it(`${name} uses the same interpolation placeholders as uz`, () => {
      // Unique names: a plural message repeats {count} once per form (`one | few | many`).
      const placeholders = (s: string): string[] =>
        [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ''))].sort();
      for (const [key, uzValue] of uzFlat) {
        expect({ key, p: placeholders(flat.get(key) ?? '') }).toEqual({
          key,
          p: placeholders(uzValue),
        });
      }
    });
  }

  it('has no empty strings', () => {
    for (const [name, flat] of [['uz', uzFlat], ...Object.entries(locales)] as const) {
      for (const [key, value] of flat) {
        expect({ name, key, empty: value.trim() === '' }).toEqual({ name, key, empty: false });
      }
    }
  });

  it('keeps the design apostrophe style in uz (ASCII, never the modifier letter or curly quotes)', () => {
    for (const [key, value] of uzFlat) {
      expect({ key, bad: /[ʻʼ‘’`´]/.test(value) }).toEqual({
        key,
        bad: false,
      });
    }
  });
});

describe('staff-only labels stay out of the eager catalogs', () => {
  it('has no staffCost and no orders namespace in uz, ru or en', () => {
    for (const catalog of [uz, ru, en]) {
      expect('staffCost' in catalog).toBe(false);
      expect('orders' in catalog).toBe(false);
    }
  });
});

describe('staff prose of the shared screens stays out of the eager catalogs', () => {
  it('has no dashboard, activity, search, customers, employees, directoryErrors or products group', () => {
    for (const catalog of [uz, ru, en]) {
      for (const group of Object.keys(staffCommonMessages.uz)) {
        expect(group in catalog).toBe(false);
      }
    }
  });
});
