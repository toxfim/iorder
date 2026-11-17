import { describe, expect, it } from 'vitest';
import { parseQuantityInput } from './quantity-input';

describe('parseQuantityInput', () => {
  it.each([
    ['2', '2'],
    ['  12  ', '12'],
    ['999999', '999999'],
    ['10.0', '10'],
  ])('accepts %j as %j', (typed, expected) => {
    expect(parseQuantityInput(typed)).toBe(expected);
  });

  it.each([
    '2,5',
    '2.5',
    '0.001',
    '',
    ' ',
    '0',
    '0,0',
    '-1',
    '1.2345',
    '1,2,3',
    'abc',
    '1e3',
    '1 000',
    '1000000',
    '+1',
  ])('rejects %j', (typed) => {
    expect(parseQuantityInput(typed)).toBeNull();
  });
});
