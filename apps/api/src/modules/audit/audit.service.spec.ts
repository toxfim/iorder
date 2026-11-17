import { describe, expect, it } from 'vitest';
import { diffFields } from './audit.service.js';

describe('diffFields', () => {
  it('keeps before AND after for each changed field', () => {
    expect(diffFields({ price: '10.00', unit: 'box' }, { price: '12.50', unit: 'box' })).toEqual({
      price: { from: '10.00', to: '12.50' },
    });
  });

  it('records creation as null -> value and removal as value -> null', () => {
    expect(diffFields({}, { productCode: 'A' })).toEqual({ productCode: { from: null, to: 'A' } });
    expect(diffFields({ productCode: 'A' }, {})).toEqual({ productCode: { from: 'A', to: null } });
  });

  it('omits unchanged fields and returns nothing when nothing changed', () => {
    expect(diffFields({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual({});
  });
});
