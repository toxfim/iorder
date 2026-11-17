import { describe, expect, it } from 'vitest';
import {
  SELECT_ALL,
  SELECT_OTHER,
  filterBySelection,
  groupByCategory,
  knownSelections,
  resolveSelection,
  scrollDeltaToListTop,
  selectionOf,
} from './category-groups';

const item = (name: string, category: string | null) => ({ name, category });

describe('groupByCategory', () => {
  const items = [
    item('a', null),
    item('b', 'Кабели'),
    item('c', 'Аудио'),
    item('d', 'Кабели'),
    item('e', 'аксессуары'),
  ];

  it('sorts alphabetically, ignoring case, with the no-category group last', () => {
    expect(groupByCategory(items, 'ru').map((g) => g.category)).toEqual([
      'аксессуары',
      'Аудио',
      'Кабели',
      null,
    ]);
  });

  it('keeps the input order inside a group', () => {
    const groups = groupByCategory(items, 'ru');
    expect(groups[2]?.items.map((i) => i.name)).toEqual(['b', 'd']);
  });

  it('orders numbers naturally and is stable for categories that differ only by case', () => {
    const numbered = [item('x', 'Group 10'), item('y', 'Group 2'), item('z', 'group 2')];
    expect(groupByCategory(numbered, 'en').map((g) => g.category)).toEqual([
      'Group 2',
      'group 2',
      'Group 10',
    ]);
  });

  it('is empty for no items', () => {
    expect(groupByCategory([], 'uz')).toEqual([]);
  });
});

describe('selection', () => {
  const groups = groupByCategory([item('a', null), item('b', 'Кабели')], 'ru');
  const known = knownSelections(groups);

  it('maps groups to selection values', () => {
    expect(known).toEqual(['Кабели', SELECT_OTHER]);
    expect(selectionOf(null)).toBe(SELECT_OTHER);
  });

  it('accepts only categories the list has; anything else is All', () => {
    expect(resolveSelection('Кабели', known)).toBe('Кабели');
    expect(resolveSelection(SELECT_OTHER, known)).toBe(SELECT_OTHER);
    for (const bad of ['nope', '', ' Кабели', 'кабели', null, undefined, 5, ['Кабели']]) {
      expect(resolveSelection(bad, known), String(bad)).toBe(SELECT_ALL);
    }
    expect(resolveSelection(SELECT_OTHER, ['Кабели'])).toBe(SELECT_ALL);
  });

  it('a real category named like the reserved value does not collide with "no category"', () => {
    const items = [item('a', null), item('b', '~other'), item('c', '~~other')];
    const known = knownSelections(groupByCategory(items, 'en'));
    expect(new Set(known).size).toBe(3);
    expect(selectionOf('~other')).toBe('~~other');
    expect(selectionOf('~~other')).toBe('~~~other');
    expect(filterBySelection(items, SELECT_OTHER).map((i) => i.name)).toEqual(['a']);
    expect(filterBySelection(items, selectionOf('~other')).map((i) => i.name)).toEqual(['b']);
    expect(resolveSelection(selectionOf('~other'), known)).toBe('~~other');
  });

  it('scrolls up only when the list top is hidden behind the tools bar', () => {
    expect(scrollDeltaToListTop(-300, 120)).toBe(-420);
    expect(scrollDeltaToListTop(120, 120)).toBe(0);
    expect(scrollDeltaToListTop(400, 120)).toBe(0);
  });

  it('filters by selection', () => {
    const items = [item('a', null), item('b', 'Кабели')];
    expect(filterBySelection(items, SELECT_ALL)).toHaveLength(2);
    expect(filterBySelection(items, 'Кабели').map((i) => i.name)).toEqual(['b']);
    expect(filterBySelection(items, SELECT_OTHER).map((i) => i.name)).toEqual(['a']);
  });
});
