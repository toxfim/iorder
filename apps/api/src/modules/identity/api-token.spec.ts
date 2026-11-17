import { describe, expect, it } from 'vitest';
import {
  generateApiToken,
  hashApiToken,
  isApiTokenScope,
  isWellFormedApiToken,
  toActorScopes,
} from './api-token.js';
import { generateSessionToken, isWellFormedSessionToken } from './session-token.js';

describe('API token format', () => {
  it('is iot_ + 43 base64url characters, unique, and hashed to hex SHA-256', () => {
    const token = generateApiToken();
    expect(token).toMatch(/^iot_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedApiToken(token)).toBe(true);
    expect(generateApiToken()).not.toBe(token);
    expect(hashApiToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken(token)).toBe(hashApiToken(token));
  });

  it('never looks like a website session token, and the other way round', () => {
    const token = generateApiToken();
    expect(isWellFormedSessionToken(token)).toBe(false);
    expect(isWellFormedApiToken(generateSessionToken())).toBe(false);
    for (const bad of ['iot_', 'iot_abc', `IOT_${token.slice(4)}`, `${token}x`, ` ${token}`]) {
      expect(isWellFormedApiToken(bad), bad).toBe(false);
    }
  });
});

describe('API token scopes', () => {
  it('may be issued only for the listed actions', () => {
    expect(isApiTokenScope('MANAGE_PRODUCT_IMAGES')).toBe(true);
    for (const other of ['MANAGE_STAFF', 'UPDATE_PRICE_LIST', 'manage_product_images', '']) {
      expect(isApiTokenScope(other), other).toBe(false);
    }
  });

  it('drops stored values that are not permission actions, so they grant nothing', () => {
    expect(toActorScopes(['MANAGE_PRODUCT_IMAGES', 'NO_SUCH_ACTION'])).toEqual([
      'MANAGE_PRODUCT_IMAGES',
    ]);
    expect(toActorScopes([])).toEqual([]);
  });
});
