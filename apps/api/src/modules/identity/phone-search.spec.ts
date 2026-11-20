import { describe, expect, it } from 'vitest';
import { phoneSearchDigits } from './phone-search.js';

describe('phoneSearchDigits (the manager new order, step 1)', () => {
  it('keeps the digits of a typed phone, whatever its spacing', () => {
    expect(phoneSearchDigits('+998 90 112-34-56')).toBe('998901123456');
    expect(phoneSearchDigits('(90) 112 34')).toBe('9011234');
    expect(phoneSearchDigits('112')).toBe('112');
  });

  it('is not a phone search for a name or fewer than three digits', () => {
    expect(phoneSearchDigits('Seller A')).toBeNull();
    expect(phoneSearchDigits('sss')).toBeNull();
    expect(phoneSearchDigits('90')).toBeNull();
    expect(phoneSearchDigits('')).toBeNull();
  });
});
