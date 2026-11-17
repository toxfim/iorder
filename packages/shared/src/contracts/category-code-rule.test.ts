import { describe, expect, it } from 'vitest';
import { suggestCategoryCodeRule } from './category-code-rule.js';

// The real «Категория» names of the sheet (dev database, 2026-10-26) plus the manager's words.
const MARKED = [
  'Аэрогрили и фритюрницы',
  'Роботы-пылесосы',
  'Вертикальные пылесосы',
  'Отпариватели',
  'Утюги',
  'Телевизоры',
  'Фены и насадки',
  'Блендеры',
  'Чайники электрические',
  'Кофемашины автоматические',
  'Кофе машина',
  'Робот пылесос',
];

const NOT_MARKED = [
  'Напольные весы',
  'Беспроводные наушники',
  'Проводные наушники',
  'Фитнес браслеты',
  'Ирригаторы',
  'Умные часы',
  'Усилители беспроводного сигнала',
  'Роутеры',
  'Внешние аккумуляторы',
  'Электробритвы',
  'Кабели и зарядные устройства',
  'Батарейки',
];

describe('suggestCategoryCodeRule', () => {
  it.each(MARKED)('%s: SN with marking', (name) => {
    expect(suggestCategoryCodeRule(name)).toEqual({
      trackingType: 'SERIAL',
      markingRequired: true,
    });
  });

  it.each(NOT_MARKED)('%s: SN without marking', (name) => {
    expect(suggestCategoryCodeRule(name)).toEqual({
      trackingType: 'SERIAL',
      markingRequired: false,
    });
  });

  it.each(['Смартфоны', 'Мобильные телефоны', 'Smartphones', 'Telefonlar', ' СМАРТФОНЫ '])(
    '%s: IMEI',
    (name) => {
      expect(suggestCategoryCodeRule(name).trackingType).toBe('IMEI');
    },
  );

  it('matches a stem only at the start of a word', () => {
    // «радиотелефон» is not a phone category by this rule; «Кофеварки» is not a coffee machine.
    expect(suggestCategoryCodeRule('Радиотелефоны').trackingType).toBe('SERIAL');
    expect(suggestCategoryCodeRule('Кофеварки').markingRequired).toBe(false);
  });
});
