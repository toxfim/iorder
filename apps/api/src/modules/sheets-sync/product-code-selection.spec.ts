import { describe, expect, it } from 'vitest';
import { ProductCodeSelection, SELECTED_PRODUCT_CODES } from './product-code-selection.js';

describe('SELECTED_PRODUCT_CODES (owner list, 2026-11-17)', () => {
  it('holds the 239 codes of the owner file plus the 105 products read before (31966 taken off 2026-11-18), no duplicates', () => {
    expect(SELECTED_PRODUCT_CODES).toHaveLength(344);
    expect(new Set(SELECTED_PRODUCT_CODES).size).toBe(344);
    expect(SELECTED_PRODUCT_CODES).not.toContain('31966');
  });

  it('every code is a sheet code (digits), never a generated IO- code', () => {
    for (const code of SELECTED_PRODUCT_CODES) expect(code).toMatch(/^\d+$/);
  });
});

describe('ProductCodeSelection', () => {
  const selection = new ProductCodeSelection(['40775', 'Honor-X7C']);

  it.each([
    ['40775', true],
    [' 40775 ', true],
    ['40775 ', true],
    ['honor-x7c', true],
    ['HONOR-X7C', true],
    ['40776', false],
    ['4077', false],
    ['407750', false],
    ['', false],
    ['   ', false],
  ])('%j -> %s', (cell, expected) => {
    expect(selection.isSelected(cell)).toBe(expected);
  });

  it('a non-text cell is never selected', () => {
    expect(selection.isSelected(40775)).toBe(false);
    expect(selection.isSelected(null)).toBe(false);
    expect(selection.isSelected(undefined)).toBe(false);
  });

  it('the production list selects a code of the owner file and one kept from before', () => {
    const production = new ProductCodeSelection(SELECTED_PRODUCT_CODES);
    expect(production.isSelected('40775')).toBe(true); // file sheet «Xiaomi.Samsung смартфоны»
    expect(production.isSelected('36302')).toBe(true); // read before through Beta system tm fbs
    expect(production.isSelected('99999')).toBe(false);
  });
});
