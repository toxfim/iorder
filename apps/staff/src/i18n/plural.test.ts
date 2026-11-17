import { describe, expect, it } from 'vitest';
import { staffCostMessages } from '@/features/staff-cost/messages';
import { withStaffCostMessages } from '@/test-utils/staff-cost-i18n';
import { coreMessages, russianPlural } from '@core/i18n';
import { createAppI18n } from './index';
import { en } from './messages/en';
import { ru } from './messages/ru';

const count = (n: number) => ({ named: { count: n }, plural: n });

describe('plural forms', () => {
  it('English: 1 product / 2 products (and 0 products)', () => {
    const { global } = createAppI18n('EN');
    // The footer names the currency the page shows (USD or so'm) through `pricesIn`.
    const say = (n: number): string =>
      global.t('prices.info', { ...count(n).named, currency: global.t('prices.pricesIn.USD') }, n);
    expect(say(1)).toBe('1 product · prices in USD');
    expect(say(2)).toBe('2 products · prices in USD');
    expect(say(0)).toBe('0 products · prices in USD');
    expect(global.t('apiErrors.inactiveInDraft', { count: 1 }, 1)).toContain('1 inactive product.');
  });

  it('Russian: one / few / many', () => {
    const { global } = createAppI18n('RU');
    const say = (n: number): string => global.t('prices.versions.items', { count: n }, n);
    expect(say(1)).toBe('1 товар');
    expect(say(21)).toBe('21 товар');
    expect(say(2)).toBe('2 товара');
    expect(say(4)).toBe('4 товара');
    expect(say(22)).toBe('22 товара');
    expect(say(5)).toBe('5 товаров');
    expect(say(11)).toBe('11 товаров');
    expect(say(12)).toBe('12 товаров');
    expect(say(14)).toBe('14 товаров');
    expect(say(0)).toBe('0 товаров');
    expect(say(111)).toBe('111 товаров');
  });

  it('Russian rule picks the three forms by the usual 1 / 2-4 / other rule', () => {
    const forms = (n: number): number => russianPlural(n, 3);
    expect([1, 21, 101].map(forms)).toEqual([0, 0, 0]);
    expect([2, 3, 4, 22, 24, 102].map(forms)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([0, 5, 9, 10, 11, 12, 13, 14, 15, 20, 25, 111, 112].map(forms)).toEqual(
      Array.from({ length: 13 }, () => 2),
    );
    // A two-form message falls back to singular / plural.
    expect([1, 2, 0].map((n) => russianPlural(n, 2))).toEqual([0, 1, 1]);
  });

  it('"N inactive products were dropped" in every language and plural form', () => {
    const say = (locale: 'UZ' | 'RU' | 'EN', n: number): string =>
      createAppI18n(locale).global.t('prices.skipped', { count: n }, n);
    expect(say('UZ', 3)).toBe("3 ta nofaol tovar ro'yxatdan chiqarildi");
    expect(say('EN', 1)).toBe('1 inactive product was dropped from the list');
    expect(say('EN', 2)).toBe('2 inactive products were dropped from the list');
    expect(say('RU', 1)).toBe('1 неактивный товар убран из прайс-листа');
    expect(say('RU', 3)).toBe('3 неактивных товара убрано из прайс-листа');
    expect(say('RU', 5)).toBe('5 неактивных товаров убрано из прайс-листа');
  });

  it('the cost tooltip title reads correctly in every language and plural form', () => {
    const say = (locale: 'UZ' | 'RU' | 'EN', n: number): string =>
      withStaffCostMessages(createAppI18n(locale)).global.t(
        'staffCost.cost.recentTitle',
        { count: n },
        n,
      );
    expect(say('UZ', 5)).toBe('Oxirgi 5 ta postavka');
    expect(say('EN', 1)).toBe('Last 1 delivery');
    expect(say('EN', 5)).toBe('Last 5 deliveries');
    expect(say('RU', 1)).toBe('Последняя 1 поставка');
    expect(say('RU', 3)).toBe('Последние 3 поставки');
    expect(say('RU', 5)).toBe('Последние 5 поставок');
  });

  it('Uzbek messages stay a single form and still accept the plural argument', () => {
    const { global } = createAppI18n('UZ');
    expect(global.t('prices.versions.items', { count: 1 }, 1)).toBe('1 ta tovar');
    expect(global.t('prices.versions.items', { count: 7 }, 7)).toBe('7 ta tovar');
  });

  it('every RU count message has exactly three forms and every EN one two', () => {
    const countKeys = [
      ['prices', 'info'],
      ['prices', 'versions', 'items'],
      ['prices', 'skipped'],
      ['apiErrors', 'inactiveProducts'],
      ['apiErrors', 'inactiveInDraft'],
      ['apiErrors', 'unknownProducts'],
      ['staffCost', 'stock', 'info'],
      ['staffCost', 'cost', 'recentTitle'],
      ['staffCost', 'sync', 'nearMiss'],
      ['staffCost', 'sync', 'rowsCount'],
      ['staffCost', 'sync', 'createdTitle'],
    ];
    const pick = (root: unknown, path: string[]): string =>
      path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as string;
    for (const path of countKeys) {
      expect({
        path,
        forms: pick({ ...coreMessages.ru, ...ru, staffCost: staffCostMessages.ru }, path).split(
          ' | ',
        ).length,
      }).toEqual({ path, forms: 3 });
      expect({
        path,
        forms: pick({ ...coreMessages.en, ...en, staffCost: staffCostMessages.en }, path).split(
          ' | ',
        ).length,
      }).toEqual({ path, forms: 2 });
    }
  });
});
