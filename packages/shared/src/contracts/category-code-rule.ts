import type { TrackingType } from './unit-codes.js';

// The company's code rule for sheet categories (owner + manager, [C] 2026-10-26):
// - phones need an IMEI, every other product has a serial number (SN);
// - the marking code (Asl belgisi) is required for the categories the manager listed: air fryers,
//   robot and upright vacuum cleaners, steamers, irons, TVs, hair dryers, blenders, electric
//   kettles, coffee machines. Explicitly NOT required: scales, earphones, fitness bands,
//   irrigators, smart watches, Wi-Fi extenders, routers. Anything not listed: not required.
// It only SUGGESTS the defaults of a new category; staff confirm it and can change it later.
// Sheet names are free text («Роботы-пылесосы», «Кофемашины автоматические»), so the match is by
// word stem at the start of a word, ignoring case.

const PHONE_STEMS = ['телефон', 'смартфон', 'smartphone', 'phone', 'telefon', 'smartfon'];

const MARKING_STEMS = [
  'аэрогрил',
  'пылесос',
  'отпаривател',
  'утюг',
  'телевизор',
  'фен',
  'блендер',
  'чайник',
  'кофемашин',
  'кофе машин',
];

export interface CategoryCodeRule {
  trackingType: TrackingType;
  markingRequired: boolean;
}

function normalized(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\s-]+/gu, ' ');
}

function hasWordStartingWith(text: string, stem: string): boolean {
  let from = text.indexOf(stem);
  while (from !== -1) {
    if (from === 0 || !/\p{L}/u.test(text[from - 1]!)) return true;
    from = text.indexOf(stem, from + 1);
  }
  return false;
}

/** The suggested defaults for a sheet category name. */
export function suggestCategoryCodeRule(name: string): CategoryCodeRule {
  const text = normalized(name);
  const matches = (stems: readonly string[]): boolean =>
    stems.some((stem) => hasWordStartingWith(text, stem));
  return {
    trackingType: matches(PHONE_STEMS) ? 'IMEI' : 'SERIAL',
    markingRequired: matches(MARKING_STEMS),
  };
}
