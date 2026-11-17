import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js';

describe('session tokens', () => {
  it('are 43 base64url characters (256 bits) and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWellFormedSessionToken(token)).toBe(true);
    }
  });

  it('hash to a stable 64-character hex digest that is not the token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(generateSessionToken())).not.toBe(hash);
  });

  it('rejects malformed values before any lookup', () => {
    for (const value of [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}!`,
      ' '.repeat(43),
    ]) {
      expect(isWellFormedSessionToken(value)).toBe(false);
    }
  });
});
