import { describe, expect, it } from 'vitest';
import {
  fromMilli,
  isSameQuantity,
  lineTotal,
  normalizeQuantity,
  stepQuantity,
  toMilli,
} from './quantity';

describe('quantity strings', () => {
  it('parses and prints thousandths without floats', () => {
    expect(toMilli('10')).toBe(10_000n);
    expect(toMilli('0.125')).toBe(125n);
    expect(fromMilli(10_500n)).toBe('10.5');
    expect(fromMilli(10_000n)).toBe('10');
    expect(normalizeQuantity('10.000')).toBe('10');
    expect(isSameQuantity('2.50', '2.5')).toBe(true);
  });

  it('rejects anything that is not a plain decimal with up to 3 fraction digits', () => {
    for (const bad of ['', '-1', '1e3', '1,5', '1.2345', ' 1']) {
      expect(() => toMilli(bad)).toThrow(RangeError);
    }
  });

  it('steps by whole units and turns zero or less into a removal', () => {
    expect(stepQuantity('10', 1)).toBe('11');
    expect(stepQuantity('2.5', -1)).toBe('1.5');
    expect(stepQuantity('1', -1)).toBeNull();
    expect(stepQuantity('0.5', -1)).toBeNull();
  });

  it('prices a line rounded half up to the cent like the server', () => {
    expect(lineTotal('1690000.00', '10')).toBe('16900000.00');
    expect(lineTotal('75000.50', '2.5')).toBe('187501.25');
    expect(lineTotal('0.01', '0.5')).toBe('0.01'); // 0.005 rounds up
    expect(lineTotal('0.01', '0.499')).toBe('0.00');
  });
});
