import { describe, expect, it } from 'vitest';
import { parseApiBaseUrl, parseBotUsername } from './env';

describe('parseApiBaseUrl', () => {
  it('defaults to /api: an empty base would collide with the SPA routes', () => {
    expect(parseApiBaseUrl(undefined, false)).toBe('/api');
    expect(parseApiBaseUrl('', false)).toBe('/api');
    expect(parseApiBaseUrl('  ', false)).toBe('/api');
  });

  it('accepts a path or an https origin and drops trailing slashes', () => {
    expect(parseApiBaseUrl('/api', false)).toBe('/api');
    expect(parseApiBaseUrl('/api/', false)).toBe('/api');
    expect(parseApiBaseUrl('/v1/api', false)).toBe('/v1/api');
    expect(parseApiBaseUrl('https://api.iorder.uz', false)).toBe('https://api.iorder.uz');
    expect(parseApiBaseUrl('https://api.iorder.uz:8443/', false)).toBe(
      'https://api.iorder.uz:8443',
    );
  });

  it('allows http only for localhost in dev', () => {
    expect(parseApiBaseUrl('http://localhost:3000', true)).toBe('http://localhost:3000');
    expect(parseApiBaseUrl('http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000');
    expect(() => parseApiBaseUrl('http://localhost:3000', false)).toThrow(/VITE_API_BASE_URL/);
    expect(() => parseApiBaseUrl('http://api.iorder.uz', true)).toThrow(/VITE_API_BASE_URL/);
  });

  it.each([
    'api',
    '//evil.test',
    String.raw`/\evil`,
    'ftp://x.test',
    'javascript:alert(1)',
    'https://user:pw@api.iorder.uz',
    'https://api.iorder.uz/?x=1',
    '/api?x=1',
    '/api#x',
    'https://',
  ])('fails fast with a clear message for %s', (bad) => {
    expect(() => parseApiBaseUrl(bad, true)).toThrow(/VITE_API_BASE_URL/);
  });
});

describe('parseBotUsername', () => {
  it('accepts a bot username and ignores the rest', () => {
    expect(parseBotUsername('@iorder_bot')).toBe('iorder_bot');
    expect(parseBotUsername('bad name')).toBeNull();
    expect(parseBotUsername(undefined)).toBeNull();
  });
});
