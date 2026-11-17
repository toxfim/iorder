import { describe, expect, it } from 'vitest';
import { checkWebhookRequest, secretsEqual, type WebhookCheckInput } from './webhook-secret.js';

const SECRET = 'a-valid-webhook-secret_123';
const ok: WebhookCheckInput = {
  mode: 'webhook',
  expectedSecret: SECRET,
  pathSecret: SECRET,
  headerSecret: SECRET,
};

describe('secretsEqual', () => {
  it('compares by value, whatever the lengths', () => {
    expect(secretsEqual(SECRET, SECRET)).toBe(true);
    expect(secretsEqual(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretsEqual('', SECRET)).toBe(false);
    expect(secretsEqual('', '')).toBe(true);
  });
});

describe('checkWebhookRequest', () => {
  it('accepts the right secret in the URL and in the header', () => {
    expect(checkWebhookRequest(ok)).toBe('OK');
  });

  it.each(['off', 'polling'] as const)(
    'answers NOT_FOUND in %s mode, even with the right secrets',
    (mode) => {
      expect(checkWebhookRequest({ ...ok, mode })).toBe('NOT_FOUND');
    },
  );

  it('answers NOT_FOUND when no secret is configured', () => {
    expect(checkWebhookRequest({ ...ok, expectedSecret: undefined })).toBe('NOT_FOUND');
  });

  it('answers NOT_FOUND for a wrong URL secret, whatever the header says', () => {
    expect(checkWebhookRequest({ ...ok, pathSecret: 'wrong' })).toBe('NOT_FOUND');
    expect(checkWebhookRequest({ ...ok, pathSecret: 'wrong', headerSecret: undefined })).toBe(
      'NOT_FOUND',
    );
  });

  it('answers UNAUTHORIZED for a missing, wrong or repeated header', () => {
    expect(checkWebhookRequest({ ...ok, headerSecret: undefined })).toBe('UNAUTHORIZED');
    expect(checkWebhookRequest({ ...ok, headerSecret: '' })).toBe('UNAUTHORIZED');
    expect(checkWebhookRequest({ ...ok, headerSecret: 'wrong' })).toBe('UNAUTHORIZED');
    expect(checkWebhookRequest({ ...ok, headerSecret: [SECRET, SECRET] })).toBe('UNAUTHORIZED');
  });
});
