import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('safeRedirect hardening', () => {
  it('keeps valid internal paths unchanged', () => {
    for (const ok of [
      '/staff/orders',
      '/staff/orders?stage=SUBMITTED&q=a%20b',
      '/cart?x=1#y',
      '/staff/orders/8f0c8f6a-2d33-4f5a-9d2e-3d2f4a1b9c11',
      '/staff/a.b/c..d',
    ]) {
      expect(safeRedirect(ok)).toBe(ok);
    }
  });

  it.each([
    ['encoded double slash', '/%2f/evil'],
    ['encoded double slash, upper case', '/%2F/evil'],
    ['encoded backslash', '/%5cevil'],
    ['double encoding', '/%252f/evil'],
    ['dot segments leaving the area', '/staff/../evil'],
    ['dot segments with a double slash', '/staff/..//evil'],
    ['encoded dot segments', '/staff/%2e%2e/evil'],
    ['double-encoded dot segments', '/staff/%252e%252e/evil'],
    ['single dot segment', '/staff/./x'],
    ['backslash dot segments', String.raw`/staff\..\evil`],
    ['full-width backslash after the slash', `/${String.fromCharCode(0xff3c)}evil`],
    ['full-width slash after the slash', `/${String.fromCharCode(0xff0f)}evil`],
    ['line separator', `/staff${String.fromCharCode(0x2028)}x`],
    ['paragraph separator', `/staff${String.fromCharCode(0x2029)}x`],
    ['DEL', `/staff${String.fromCharCode(0x7f)}x`],
    ['C1 control', `/staff${String.fromCharCode(0x85)}x`],
    ['newline', '/staff\nx'],
    ['null byte', `/staff${String.fromCharCode(0x0)}x`],
    ['stray percent', '/100%'],
    ['600 characters', `/${'a'.repeat(599)}`],
  ])('rejects %s', (_name, bad) => {
    expect(safeRedirect(bad)).toBeNull();
  });

  it('accepts exactly 512 characters', () => {
    const edge = `/${'a'.repeat(511)}`;
    expect(safeRedirect(edge)).toBe(edge);
  });
});
