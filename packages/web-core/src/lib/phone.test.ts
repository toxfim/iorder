import { describe, expect, it } from 'vitest';
import { formatPhone, formatPhoneDigits, phoneDigits, phoneMatches, telHref } from './phone';

describe('phoneDigits / phoneMatches', () => {
  it('reduces a phone to its digits', () => {
    expect(phoneDigits('+998 93 555 0147')).toBe('998935550147');
  });

  it('finds a phone by any typed form of its digits', () => {
    for (const typed of ['+998 93 555 0147', '998935550147', '93 555', '5550147', '(93) 555-01']) {
      expect(phoneMatches('+998935550147', typed)).toBe(true);
    }
    expect(phoneMatches('+998935550147', '93 556')).toBe(false);
  });

  it('never matches a search with letters or without digits', () => {
    expect(phoneMatches('+998935550147', 'jasur 77')).toBe(false);
    expect(phoneMatches('+998935550147', ' + ')).toBe(false);
  });
});

describe('telHref', () => {
  it('keeps digits and the plus only', () => {
    expect(telHref('+998 90 111-22-33')).toBe('tel:+998901112233');
    expect(telHref('(90) 111 22 33')).toBe('tel:901112233');
  });

  it('drops anything that could change the link', () => {
    expect(telHref('+99890";javascript:alert(1)')).toBe('tel:+998901');
  });
});

describe('formatPhoneDigits / formatPhone', () => {
  it('groups an Uzbek number as code, operator, 3 and 4 digits', () => {
    expect(formatPhoneDigits('998935550147')).toBe('998 93 555 0147');
    expect(formatPhone('+998935550147')).toBe('+998 93 555 0147');
  });

  it('formats partial input while typing', () => {
    expect(formatPhoneDigits('')).toBe('');
    expect(formatPhoneDigits('9')).toBe('9');
    expect(formatPhoneDigits('998')).toBe('998');
    expect(formatPhoneDigits('9987')).toBe('998 7');
    expect(formatPhoneDigits('99877')).toBe('998 77');
    expect(formatPhoneDigits('998770')).toBe('998 77 0');
    expect(formatPhoneDigits('99893555')).toBe('998 93 555');
    expect(formatPhoneDigits('998935550')).toBe('998 93 555 0');
  });

  it('keeps extra digits instead of dropping them, up to the E.164 limit', () => {
    expect(formatPhoneDigits('9989355501479')).toBe('998 93 555 0147 9');
    expect(formatPhoneDigits('1'.repeat(20))).toBe('111 111 111 111 111');
  });

  it('groups other countries in threes and ignores non-digits', () => {
    expect(formatPhoneDigits('+7 (900) 123-45-67')).toBe('790 012 345 67');
    expect(formatPhone('+79001234567')).toBe('+790 012 345 67');
  });

  it('leaves a value without digits as it is', () => {
    expect(formatPhone('n/a')).toBe('n/a');
  });
});
